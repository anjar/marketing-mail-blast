import {
  CampaignStatus,
  EnqueueState,
  PrismaClient,
  RecipientStatus,
} from '@prisma/client';
import IORedis, { Redis } from 'ioredis';
import {
  describeIntegration,
  flushRedis,
  mailpitCount,
  mailpitReset,
  prismaClient,
  resetDb,
} from './helpers';
import { loadConfig } from '../../src/config/app-config';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MailService } from '../../src/mail/mail.service';
import { ProgressService } from '../../src/progress/progress.service';
import { CampaignCountersService } from '../../src/campaign/campaign-counters.service';
import { CompletionService } from '../../src/campaign/completion.service';
import { OrphanSweepService } from '../../src/reconciliation/orphan-sweep.service';
import { DeliveryProcessor } from '../../src/delivery/delivery.processor';
import { deliveryJobId } from '../../src/queue/queue.constants';

/**
 * User Story 4 — interruption safety (T050/T051/T052/T053). These tests drive the
 * services DIRECTLY (no live workers) so crafted intermediate states are not
 * consumed by a background worker, isolating each interruption boundary.
 */
describeIntegration('Recovery and idempotency', () => {
  const config = loadConfig();
  let prisma: PrismaClient;
  let redis: Redis;
  let orphanSweep: OrphanSweepService;
  let completion: CompletionService;
  let delivery: DeliveryProcessor;

  beforeAll(() => {
    prisma = prismaClient();
    redis = new IORedis({
      host: config.redis.host,
      port: config.redis.port,
      maxRetriesPerRequest: null,
    });
    const prismaSvc = prisma as unknown as PrismaService;
    const progress = new ProgressService(prismaSvc);
    const counters = new CampaignCountersService(prismaSvc, progress);
    const mail = new MailService(config);
    orphanSweep = new OrphanSweepService(prismaSvc);
    completion = new CompletionService(prismaSvc, progress, counters);
    delivery = new DeliveryProcessor(config, redis, prismaSvc, mail);
  });

  beforeEach(async () => {
    await flushRedis();
    await resetDb(prisma);
    await mailpitReset();
  });

  afterAll(async () => {
    await redis.quit();
    await prisma.$disconnect();
  });

  async function runningCampaign(): Promise<string> {
    const c = await prisma.campaign.create({
      data: { subject: 'S', body: 'Hi {{name}}', status: CampaignStatus.RUNNING, snapshotMaxRecipientId: 0n },
    });
    return c.id;
  }

  it('terminal recipient re-run of a delivery job is a no-op (FR-038)', async () => {
    const source = await prisma.recipient.create({ data: { email: 't@example.com', name: 'T' } });
    const campaignId = await runningCampaign();
    const rec = await prisma.campaignRecipient.create({
      data: {
        campaignId,
        sourceRecipientId: source.id,
        snapshotEmail: 't@example.com',
        normalizedEmail: 't@example.com',
        personalizedName: 'T',
        status: RecipientStatus.SENT,
        enqueueState: EnqueueState.TERMINAL,
        terminalAt: new Date(),
      },
    });

    const before = await mailpitCount();
    await delivery.process({
      data: { campaignId, campaignRecipientId: rec.id },
      opts: {},
      attemptsMade: 0,
    } as never);

    expect(await mailpitCount()).toBe(before);
    const reloaded = await prisma.campaignRecipient.findUnique({ where: { id: rec.id } });
    expect(reloaded?.status).toBe(RecipientStatus.SENT);
    expect(await prisma.deliveryAttempt.count({ where: { campaignRecipientId: rec.id } })).toBe(0);
  });

  it('orphaned IN_PROGRESS (expired lease) reconciles to DELIVERY_UNKNOWN (FR-022c)', async () => {
    const source = await prisma.recipient.create({ data: { email: 'o@example.com', name: 'O' } });
    const campaignId = await runningCampaign();
    const rec = await prisma.campaignRecipient.create({
      data: {
        campaignId,
        sourceRecipientId: source.id,
        snapshotEmail: 'o@example.com',
        normalizedEmail: 'o@example.com',
        personalizedName: 'O',
        status: RecipientStatus.IN_PROGRESS,
        enqueueState: EnqueueState.PROCESSING,
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() - 60000),
        attemptStartedAt: new Date(Date.now() - 120000),
      },
    });

    expect(await orphanSweep.sweepCampaign(campaignId)).toBe(1);
    const reloaded = await prisma.campaignRecipient.findUnique({ where: { id: rec.id } });
    expect(reloaded?.status).toBe(RecipientStatus.DELIVERY_UNKNOWN);
    expect(reloaded?.enqueueState).toBe(EnqueueState.TERMINAL);
  });

  it('leaves a LIVE-lease IN_PROGRESS row untouched (FR-022b)', async () => {
    const source = await prisma.recipient.create({ data: { email: 'l@example.com', name: 'L' } });
    const campaignId = await runningCampaign();
    const rec = await prisma.campaignRecipient.create({
      data: {
        campaignId,
        sourceRecipientId: source.id,
        snapshotEmail: 'l@example.com',
        normalizedEmail: 'l@example.com',
        personalizedName: 'L',
        status: RecipientStatus.IN_PROGRESS,
        enqueueState: EnqueueState.PROCESSING,
        leaseOwner: 'live-worker',
        leaseExpiresAt: new Date(Date.now() + 60000),
      },
    });

    expect(await orphanSweep.sweepCampaign(campaignId)).toBe(0);
    const reloaded = await prisma.campaignRecipient.findUnique({ where: { id: rec.id } });
    expect(reloaded?.status).toBe(RecipientStatus.IN_PROGRESS);
  });

  it('does not complete while a recipient is pending (FR-030)', async () => {
    const source = await prisma.recipient.create({ data: { email: 'p@example.com', name: 'P' } });
    const campaignId = await runningCampaign();
    await prisma.campaignRecipient.create({
      data: {
        campaignId,
        sourceRecipientId: source.id,
        snapshotEmail: 'p@example.com',
        normalizedEmail: 'p@example.com',
        personalizedName: 'P',
        status: RecipientStatus.PENDING,
        enqueueState: EnqueueState.READY_TO_QUEUE,
      },
    });

    expect(await completion.tryComplete(campaignId)).toBeNull();
    const c = await prisma.campaign.findUnique({ where: { id: campaignId } });
    expect(c?.status).toBe(CampaignStatus.RUNNING);
  });

  it('completes COMPLETED when all terminal + reconciled; job id is deterministic', async () => {
    const source = await prisma.recipient.create({ data: { email: 's@example.com', name: 'S' } });
    const campaignId = await runningCampaign();
    const rec = await prisma.campaignRecipient.create({
      data: {
        campaignId,
        sourceRecipientId: source.id,
        snapshotEmail: 's@example.com',
        normalizedEmail: 's@example.com',
        personalizedName: 'S',
        status: RecipientStatus.SENT,
        enqueueState: EnqueueState.TERMINAL,
        terminalAt: new Date(),
      },
    });

    expect(deliveryJobId(campaignId, rec.id)).toBe(`deliver_${campaignId}_${rec.id}`);
    const result = await completion.tryComplete(campaignId);
    expect(result).toBe(CampaignStatus.COMPLETED);
    const c = await prisma.campaign.findUnique({ where: { id: campaignId } });
    expect(c?.completedAt).not.toBeNull();
  });
});
