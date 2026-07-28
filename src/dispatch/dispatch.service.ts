import { Inject, Injectable, Logger } from '@nestjs/common';
import { EnqueueState } from '@prisma/client';
import { Queue } from 'bullmq';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import {
  DELIVERY_QUEUE,
  DeliveryJobData,
  deliveryJobId,
} from '../queue/queue.constants';

/**
 * Durable queue dispatch (Constitution III/V). A committed CampaignRecipient
 * never depends on a single best-effort enqueue: accepted rows are persisted
 * READY_TO_QUEUE first, then this dispatcher repeatedly finds them by keyset,
 * adds bounded addBulk() delivery jobs with deterministic ids, and marks them
 * QUEUED. Safe to repeat after interruption at any boundary:
 *   - crash before addBulk        -> rows stay READY_TO_QUEUE, re-dispatched
 *   - crash after addBulk pre-DB   -> deterministic id makes re-add a no-op,
 *                                     rows still READY_TO_QUEUE -> re-marked QUEUED
 * Backpressure: pause when buffered jobs reach maxBufferedQueueJobs.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DELIVERY_QUEUE) private readonly deliveryQueue: Queue<DeliveryJobData>,
    private readonly prisma: PrismaService,
  ) {}

  /** Current buffered (unfinished) job count for backpressure decisions. */
  private async bufferedJobCount(): Promise<number> {
    const counts = await this.deliveryQueue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'prioritized',
      'waiting-children',
    );
    return Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  }

  /**
   * Dispatch READY_TO_QUEUE recipients for one campaign until either none remain
   * or the backlog cap is reached. Returns the number of jobs enqueued.
   */
  async dispatchCampaign(campaignId: string): Promise<number> {
    const { enqueueBatchSize, maxBufferedQueueJobs } = this.config.dispatch;
    let cursorId = 0;
    let enqueued = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const buffered = await this.bufferedJobCount();
      if (buffered >= maxBufferedQueueJobs) {
        this.logger.debug(
          `Backpressure: buffered=${buffered} >= cap=${maxBufferedQueueJobs}; pausing dispatch`,
        );
        break;
      }

      const rows = await this.prisma.campaignRecipient.findMany({
        where: {
          campaignId,
          enqueueState: EnqueueState.READY_TO_QUEUE,
          id: { gt: cursorId },
        },
        orderBy: { id: 'asc' },
        take: enqueueBatchSize,
        select: { id: true },
      });
      if (rows.length === 0) break;

      // Add jobs through a bounded addBulk() (never build the whole list in memory).
      await this.deliveryQueue.addBulk(
        rows.map((r) => ({
          name: 'deliver',
          data: { campaignId, campaignRecipientId: r.id },
          opts: {
            jobId: deliveryJobId(campaignId, r.id),
            attempts: this.config.retry.maxDeliveryAttempts,
            backoff: { type: 'exponential', delay: this.config.retry.backoffMs },
            removeOnComplete: {
              age: this.config.queueRetention.removeOnCompleteAgeS,
              count: this.config.queueRetention.removeOnCompleteCount,
            },
            removeOnFail: {
              age: this.config.queueRetention.removeOnFailAgeS,
              count: this.config.queueRetention.removeOnFailCount,
            },
          },
        })),
      );

      // Only after the jobs exist do we advance the durable enqueue state.
      await this.prisma.campaignRecipient.updateMany({
        where: {
          id: { in: rows.map((r) => r.id) },
          enqueueState: EnqueueState.READY_TO_QUEUE,
        },
        data: { enqueueState: EnqueueState.QUEUED },
      });

      enqueued += rows.length;
      cursorId = rows[rows.length - 1].id;
    }

    if (enqueued > 0) {
      this.logger.debug(`Dispatched ${enqueued} delivery jobs for campaign ${campaignId}`);
    }
    return enqueued;
  }
}
