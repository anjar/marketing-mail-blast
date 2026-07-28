import { INestApplication } from '@nestjs/common';
import { PrismaClient, RecipientStatus } from '@prisma/client';
import request from 'supertest';
import {
  createTestApp,
  describeIntegration,
  flushRedis,
  mailpitCount,
  mailpitReset,
  prismaClient,
  resetDb,
  seedRecipients,
  waitFor,
} from './helpers';

/**
 * User Stories 2, 3, 5 end-to-end against real Mailpit:
 *  - personalization + valid delivery -> SENT (T035)
 *  - invalid/missing -> REJECTED, never delivered (T034)
 *  - duplicate normalized -> earliest accepted, rest DUPLICATE_EMAIL (T033)
 *  - progress reconciliation total = pending+rejected+sent+failed+unknown (T045)
 *  - completion COMPLETED_WITH_ISSUES + counters reconcile (T058)
 */
describeIntegration('Delivery, validation, dedupe, progress, completion', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let campaignId: string;

  beforeAll(async () => {
    prisma = prismaClient();
    await flushRedis();
    await resetDb(prisma);
    await mailpitReset();
    await seedRecipients(prisma, [
      { email: 'alice@example.com', name: 'Alicia' }, // valid, accepted
      { email: '  ALICE@example.com ', name: 'Dup' }, // duplicate normalized -> rejected
      { email: 'bob@example.com', name: '' }, // valid, blank name -> Customer
      { email: 'not-an-email', name: 'Bad' }, // invalid -> EMAIL_INVALID_FORMAT
      { email: '   ', name: 'Empty' }, // missing -> EMAIL_MISSING
    ]);
    app = await createTestApp();

    const res = await request(app.getHttpServer())
      .post('/api/campaigns')
      .send({ subject: 'Dry Run', body: 'Hello {{name}}!' })
      .expect(201);
    campaignId = res.body.id;

    // Wait for the campaign to reach a terminal status.
    await waitFor(async () => {
      const c = await prisma.campaign.findUnique({ where: { id: campaignId } });
      return c!.status === 'COMPLETED' || c!.status === 'COMPLETED_WITH_ISSUES';
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('classifies each recipient disposition correctly', async () => {
    const rows = await prisma.campaignRecipient.findMany({
      where: { campaignId },
      orderBy: { sourceRecipientId: 'asc' },
    });
    const byEmail = (e: string) => rows.find((r) => r.snapshotEmail?.trim() === e);

    expect(byEmail('alice@example.com')?.status).toBe(RecipientStatus.SENT);

    const dup = rows.find((r) => r.snapshotEmail === '  ALICE@example.com ');
    expect(dup?.status).toBe(RecipientStatus.REJECTED);
    expect(dup?.rejectionReason).toBe('DUPLICATE_EMAIL');
    expect(dup?.duplicateOfId).toBe(byEmail('alice@example.com')?.id);

    expect(byEmail('bob@example.com')?.status).toBe(RecipientStatus.SENT);
    expect(byEmail('bob@example.com')?.personalizedName).toBe('Customer');

    expect(byEmail('not-an-email')?.rejectionReason).toBe('EMAIL_INVALID_FORMAT');
    const missing = rows.find((r) => r.snapshotName === 'Empty');
    expect(missing?.rejectionReason).toBe('EMAIL_MISSING');
  });

  it('delivered exactly the accepted, unique recipients to Mailpit (SC-005/006)', async () => {
    const total = await mailpitCount();
    expect(total).toBe(2); // alice + bob only; duplicates/invalid never delivered
  });

  it('progress reconciles and breaks down by reason (FR-028/029)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/campaigns/${campaignId}/progress`)
      .expect(200);
    const p = res.body;
    expect(p.total).toBe(p.pending + p.rejected + p.sent + p.failed + p.deliveryUnknown);
    expect(p.sent).toBe(2);
    expect(p.rejected).toBe(3);
    expect(p.pending).toBe(0);
    expect(p.rejectedByReason.DUPLICATE_EMAIL).toBe(1);
    expect(p.rejectedByReason.EMAIL_INVALID_FORMAT).toBe(1);
    expect(p.rejectedByReason.EMAIL_MISSING).toBe(1);
  });

  it('completes as COMPLETED_WITH_ISSUES with reconciled counters (FR-032/033)', async () => {
    const c = await prisma.campaign.findUnique({ where: { id: campaignId } });
    expect(c?.status).toBe('COMPLETED_WITH_ISSUES');
    expect(c?.completedAt).not.toBeNull();
    expect(c?.totalCount).toBe(
      c!.pendingCount + c!.rejectedCount + c!.sentCount + c!.failedCount + c!.deliveryUnknownCount,
    );
  });

  it('re-enables submission after completion (FR-034)', async () => {
    await request(app.getHttpServer()).get('/api/campaigns/active').expect(204);
    await request(app.getHttpServer())
      .post('/api/campaigns')
      .send({ subject: 'Next', body: 'again' })
      .expect(201);
  });
});
