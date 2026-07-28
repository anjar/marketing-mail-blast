import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { CampaignStatus } from '@prisma/client';
import { Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { CompletionService } from '../campaign/completion.service';
import {
  MAINTENANCE_QUEUE,
  MaintenanceJobData,
  QUEUE_MAINTENANCE,
  REDIS_CONNECTION,
  maintenanceJobId,
} from '../queue/queue.constants';
import { OrphanSweepService } from './orphan-sweep.service';

/**
 * Repeatable maintenance driver (T057). For each active campaign it: sweeps
 * orphaned leases, dispatches READY_TO_QUEUE work (with backpressure), then
 * attempts completion. When the campaign is terminal it removes the repeatable
 * maintenance job. All steps are idempotent and safe to repeat after interruption.
 */
@Injectable()
export class MaintenanceProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MaintenanceProcessor.name);
  private worker?: Worker<MaintenanceJobData>;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly connection: Redis,
    @Inject(MAINTENANCE_QUEUE) private readonly maintenanceQueue: Queue<MaintenanceJobData>,
    private readonly prisma: PrismaService,
    private readonly orphanSweep: OrphanSweepService,
    private readonly dispatch: DispatchService,
    private readonly completion: CompletionService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<MaintenanceJobData>(
      QUEUE_MAINTENANCE,
      async (job) => this.run(job),
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`Maintenance job ${job?.id} failed: ${err.message}`),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  async run(job: Job<MaintenanceJobData>): Promise<void> {
    const { campaignId } = job.data;
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!campaign) {
      await this.removeRepeatable(campaignId);
      return;
    }
    if (campaign.status === CampaignStatus.PREPARING) {
      // Still preparing: dispatch what is already READY_TO_QUEUE, sweep orphans.
      await this.orphanSweep.sweepCampaign(campaignId);
      await this.dispatch.dispatchCampaign(campaignId);
      return;
    }
    if (campaign.status !== CampaignStatus.RUNNING) {
      // Already terminal -> stop the repeatable job.
      await this.removeRepeatable(campaignId);
      return;
    }

    await this.orphanSweep.sweepCampaign(campaignId);
    await this.dispatch.dispatchCampaign(campaignId);
    const terminal = await this.completion.tryComplete(campaignId);
    if (terminal) {
      await this.removeRepeatable(campaignId);
    }
  }

  private async removeRepeatable(campaignId: string): Promise<void> {
    try {
      // Remove any repeatable maintenance schedule for this campaign.
      const repeatables = await this.maintenanceQueue.getRepeatableJobs();
      for (const r of repeatables) {
        if (r.id === maintenanceJobId(campaignId) || r.name === 'maintenance') {
          if (r.id === maintenanceJobId(campaignId)) {
            await this.maintenanceQueue.removeRepeatableByKey(r.key);
          }
        }
      }
    } catch (err) {
      this.logger.warn(`Could not remove repeatable maintenance for ${campaignId}: ${(err as Error).message}`);
    }
  }
}
