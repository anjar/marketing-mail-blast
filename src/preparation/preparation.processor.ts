import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { CampaignStatus, EnqueueState, Prisma, RecipientStatus } from '@prisma/client';
import { Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { RecipientService, SourceRecipientRow } from '../recipient/recipient.service';
import { CampaignCountersService } from '../campaign/campaign-counters.service';
import { isPrismaUniqueViolation } from '../common/errors';
import { isUniqueViolationOn } from '../common/unique-violation';
import { resolvePersonalizedName } from '../mail/personalization';
import { normalizeEmail } from './email-validator';
import {
  MAINTENANCE_QUEUE,
  MaintenanceJobData,
  PreparationJobData,
  QUEUE_PREPARATION,
  REDIS_CONNECTION,
  maintenanceJobId,
} from '../queue/queue.constants';

/**
 * Campaign preparation worker. Scans the snapshot in stable ascending id order
 * with keyset pagination (never deep OFFSET, never the full dataset in memory),
 * materializing one CampaignRecipient per source recipient. Resumable from the
 * persisted preparationCursor after any interruption (FR-037).
 */
@Injectable()
export class PreparationProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PreparationProcessor.name);
  private worker?: Worker<PreparationJobData>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS_CONNECTION) private readonly connection: Redis,
    @Inject(MAINTENANCE_QUEUE) private readonly maintenanceQueue: Queue<MaintenanceJobData>,
    private readonly prisma: PrismaService,
    private readonly recipients: RecipientService,
    private readonly counters: CampaignCountersService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<PreparationJobData>(
      QUEUE_PREPARATION,
      async (job) => this.prepare(job),
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`Preparation job ${job?.id} failed: ${err.message}`),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  /** Ensure a repeatable maintenance job drives dispatch/completion for a campaign. */
  private async ensureMaintenance(campaignId: string): Promise<void> {
    await this.maintenanceQueue.add(
      'maintenance',
      { campaignId },
      {
        jobId: maintenanceJobId(campaignId),
        repeat: { every: this.config.lease.maintenanceIntervalMs },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async prepare(job: Job<PreparationJobData>): Promise<void> {
    const { campaignId } = job.data;
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      this.logger.warn(`Preparation: campaign ${campaignId} not found`);
      return;
    }
    if (campaign.status !== CampaignStatus.PREPARING) {
      this.logger.log(`Preparation: campaign ${campaignId} not PREPARING (${campaign.status}); skip`);
      return;
    }

    // Start dispatch concurrently with preparation for large campaigns.
    await this.ensureMaintenance(campaignId);

    const snapshotMax = campaign.snapshotMaxRecipientId;
    let cursor = campaign.preparationCursor;
    const batchSize = this.config.preparation.batchSize;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await this.recipients.keysetPage(cursor, snapshotMax, batchSize);
      if (page.length === 0) break;

      for (const row of page) {
        await this.materialize(campaignId, row);
      }

      cursor = page[page.length - 1].id;
      // Persist the cursor BEFORE loading another batch (resumability).
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: { preparationCursor: cursor },
      });
    }

    // Preparation finished: refresh counters and transition PREPARING -> RUNNING
    // atomically (only if still PREPARING).
    await this.counters.recompute(campaignId);
    await this.prisma.campaign.updateMany({
      where: { id: campaignId, status: CampaignStatus.PREPARING },
      data: { status: CampaignStatus.RUNNING },
    });
    this.logger.log(`Preparation complete for campaign ${campaignId}`);
  }

  /**
   * Materialize one CampaignRecipient. Idempotent: a resumed run that re-touches
   * an already-prepared source recipient is a no-op (unique campaignId+source).
   * Validation + dedupe classify the disposition before any delivery job exists.
   */
  private async materialize(campaignId: string, row: SourceRecipientRow): Promise<void> {
    const { normalized, rejection } = normalizeEmail(row.email);
    const personalizedName = resolvePersonalizedName(row.name);

    const base = {
      campaignId,
      sourceRecipientId: row.id,
      snapshotEmail: row.email,
      snapshotName: row.name,
      personalizedName,
    };

    // Invalid / missing email -> REJECTED, never queued (FR-016).
    if (rejection) {
      await this.createRow({
        ...base,
        normalizedEmail: null,
        status: RecipientStatus.REJECTED,
        rejectionReason: rejection,
        enqueueState: EnqueueState.TERMINAL,
        terminalAt: new Date(),
      });
      return;
    }

    // Accepted candidate: try to claim the canonical normalized-email slot.
    try {
      await this.createRow({
        ...base,
        normalizedEmail: normalized,
        status: RecipientStatus.PENDING,
        enqueueState: EnqueueState.READY_TO_QUEUE,
      });
    } catch (err) {
      if (!isPrismaUniqueViolation(err)) throw err;
      // Already prepared (resume) -> skip. The (campaignId, sourceRecipientId)
      // index is schema-defined so Prisma reports its column names in the target.
      if (isUniqueViolationOn(err, 'sourceRecipientId')) return;
      // Otherwise the only other unique index that can fire is the canonical
      // accepted normalized-email index -> duplicate normalized email (FR-018).
      const canonical = await this.prisma.campaignRecipient.findFirst({
        where: {
          campaignId,
          normalizedEmail: normalized,
          status: { not: RecipientStatus.REJECTED },
        },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      try {
        await this.createRow({
          ...base,
          normalizedEmail: normalized,
          status: RecipientStatus.REJECTED,
          rejectionReason: 'DUPLICATE_EMAIL',
          duplicateOfId: canonical?.id ?? null,
          enqueueState: EnqueueState.TERMINAL,
          terminalAt: new Date(),
        });
      } catch (err2) {
        if (isUniqueViolationOn(err2, 'sourceRecipientId')) return; // resume race
        throw err2;
      }
    }
  }

  private async createRow(data: Prisma.CampaignRecipientUncheckedCreateInput): Promise<void> {
    await this.prisma.campaignRecipient.create({ data });
  }
}
