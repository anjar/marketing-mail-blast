import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import {
  AttemptStatus,
  DeliveryFailureReason,
  EnqueueState,
  RecipientStatus,
} from '@prisma/client';
import { Job, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { personalizeBody } from '../mail/personalization';
import { DeliveryJobData, QUEUE_DELIVERY, deliveryJobId } from '../queue/queue.constants';
import { createWorkerConnection } from '../queue/redis.factory';
import { classifyError } from './outcome-classifier';

/**
 * Delivery worker. Processes exactly one CampaignRecipient per job. Enforces the
 * whole per-recipient outcome contract (FR-020..024, FR-038):
 *  - terminal recipient  -> successful no-op, never re-sent
 *  - atomic PENDING->IN_PROGRESS claim with a renewable lease before SMTP
 *  - DeliveryAttempt created before SMTP communication
 *  - SENT / FAILED / DELIVERY_UNKNOWN classified conservatively
 *  - retryable pre-acceptance failures retried up to the max, then terminal FAILED
 */
@Injectable()
export class DeliveryProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DeliveryProcessor.name);
  private readonly workers: Worker<DeliveryJobData>[] = [];
  private readonly connections: Redis[] = [];
  private readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  onModuleInit(): void {
    const { count, concurrency, rateLimitMax, rateLimitDurationMs } = this.config.workers;
    for (let i = 0; i < count; i++) {
      const connection = createWorkerConnection(this.config);
      this.connections.push(connection);
      const worker = new Worker<DeliveryJobData>(
        QUEUE_DELIVERY,
        async (job) => this.process(job),
        {
          connection,
          concurrency,
          limiter: { max: rateLimitMax, duration: rateLimitDurationMs },
        },
      );
      worker.on('failed', (job, err) => this.onJobFailed(job, err));
      this.workers.push(worker);
    }
    this.logger.log(
      `Started ${count} delivery worker(s), concurrency=${concurrency}, id=${this.workerId}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all(this.connections.map((c) => c.quit().catch(() => undefined)));
  }

  /**
   * Reconcile a recipient whose BullMQ job exhausted retries and landed in the
   * failed set. It must NOT remain pending merely because the queue job failed
   * (FR-023a / T043). Only touches still-non-terminal PENDING/IN_PROGRESS rows.
   */
  private async onJobFailed(job: Job<DeliveryJobData> | undefined, err: Error): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? this.config.retry.maxDeliveryAttempts;
    const exhausted = job.attemptsMade >= attempts;
    if (!exhausted) return;
    try {
      await this.prisma.campaignRecipient.updateMany({
        where: {
          id: job.data.campaignRecipientId,
          status: { in: [RecipientStatus.PENDING, RecipientStatus.IN_PROGRESS] },
        },
        data: {
          status: RecipientStatus.FAILED,
          deliveryFailureReason: DeliveryFailureReason.RETRIES_EXHAUSTED,
          enqueueState: EnqueueState.TERMINAL,
          terminalAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      this.logger.warn(
        `Reconciled exhausted recipient ${job.data.campaignRecipientId} -> FAILED (${err.message})`,
      );
    } catch (e) {
      this.logger.error(`Failed reconciling exhausted job ${job.id}: ${(e as Error).message}`);
    }
  }

  async process(job: Job<DeliveryJobData>): Promise<void> {
    const { campaignId, campaignRecipientId } = job.data;

    const recipient = await this.prisma.campaignRecipient.findUnique({
      where: { id: campaignRecipientId },
    });

    // Precondition guard (atomic claim below). Missing / wrong campaign / already
    // terminal -> successful no-op; never a second SMTP submission (FR-038).
    if (!recipient || recipient.campaignId !== campaignId) return;
    if (this.isTerminal(recipient.status)) {
      if (recipient.enqueueState !== EnqueueState.TERMINAL) {
        await this.prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: { enqueueState: EnqueueState.TERMINAL },
        });
      }
      return;
    }

    // Atomic claim: only a row still PENDING can be moved to IN_PROGRESS. This
    // prevents a second concurrent attempt on a live-leased row (FR-022b).
    const staleness = this.config.lease.stalenessMs;
    const claimed = await this.prisma.campaignRecipient.updateMany({
      where: { id: recipient.id, status: RecipientStatus.PENDING },
      data: {
        status: RecipientStatus.IN_PROGRESS,
        enqueueState: EnqueueState.PROCESSING,
        leaseOwner: this.workerId,
        leaseExpiresAt: new Date(Date.now() + staleness),
        attemptStartedAt: new Date(),
        deliveryAttemptCount: { increment: 1 },
      },
    });
    if (claimed.count === 0) {
      // Not claimable (already IN_PROGRESS with a live lease, or became terminal).
      return;
    }

    const current = await this.prisma.campaignRecipient.findUnique({
      where: { id: recipient.id },
    });
    if (!current || !current.normalizedEmail) {
      // Defensive: an accepted row must have a normalized email.
      return;
    }
    const attemptNumber = current.deliveryAttemptCount;

    // DeliveryAttempt created BEFORE SMTP communication (audit history).
    const attempt = await this.prisma.deliveryAttempt.create({
      data: {
        campaignRecipientId: recipient.id,
        attemptNumber,
        jobId: deliveryJobId(campaignId, recipient.id),
        status: AttemptStatus.STARTED,
      },
    });

    const heartbeat = this.startHeartbeat(recipient.id);
    try {
      const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
      if (!campaign) return;
      const body = personalizeBody(campaign.body, current.personalizedName);

      const result = await this.mail.send({
        to: current.normalizedEmail,
        subject: campaign.subject,
        body,
      });

      const accepted = result.accepted.some(
        (a) => a.toLowerCase() === current.normalizedEmail!.toLowerCase(),
      );
      if (accepted) {
        await this.finalizeSent(recipient.id, attempt.id, result.response);
      } else {
        // Server returned but did not accept our recipient -> definitive FAILED.
        await this.finalizeFailed(
          recipient.id,
          attempt.id,
          DeliveryFailureReason.SMTP_REJECTED,
          result.response || 'not accepted',
        );
      }
    } catch (err) {
      await this.handleSendError(job, recipient.id, attempt.id, attemptNumber, err);
      // Re-throw only for retryable-not-yet-exhausted (see handleSendError return).
      if ((err as { __retry?: boolean }).__retry) throw err;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private isTerminal(status: RecipientStatus): boolean {
    return (
      status === RecipientStatus.SENT ||
      status === RecipientStatus.FAILED ||
      status === RecipientStatus.DELIVERY_UNKNOWN ||
      status === RecipientStatus.REJECTED
    );
  }

  /** Renew the lease while the attempt is live so recovery won't orphan it. */
  private startHeartbeat(recipientId: number): NodeJS.Timeout {
    const { heartbeatMs, stalenessMs } = this.config.lease;
    return setInterval(() => {
      void this.prisma.campaignRecipient
        .updateMany({
          where: {
            id: recipientId,
            leaseOwner: this.workerId,
            status: RecipientStatus.IN_PROGRESS,
          },
          data: { leaseExpiresAt: new Date(Date.now() + stalenessMs) },
        })
        .catch(() => undefined);
    }, heartbeatMs);
  }

  private async finalizeSent(recipientId: number, attemptId: number, response: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: {
          status: RecipientStatus.SENT,
          enqueueState: EnqueueState.TERMINAL,
          terminalAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
      this.prisma.deliveryAttempt.update({
        where: { id: attemptId },
        data: {
          status: AttemptStatus.SUCCEEDED,
          acceptanceDefinitive: true,
          smtpResponse: response.slice(0, 1000),
          finishedAt: new Date(),
        },
      }),
    ]);
  }

  private async finalizeFailed(
    recipientId: number,
    attemptId: number,
    reason: DeliveryFailureReason,
    response: string,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: {
          status: RecipientStatus.FAILED,
          deliveryFailureReason: reason,
          enqueueState: EnqueueState.TERMINAL,
          terminalAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
      this.prisma.deliveryAttempt.update({
        where: { id: attemptId },
        data: {
          status: AttemptStatus.FAILED,
          acceptanceDefinitive: true,
          smtpResponse: response.slice(0, 1000),
          finishedAt: new Date(),
        },
      }),
    ]);
  }

  private async finalizeUnknown(
    recipientId: number,
    attemptId: number,
    response: string,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: {
          status: RecipientStatus.DELIVERY_UNKNOWN,
          enqueueState: EnqueueState.TERMINAL,
          terminalAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
      this.prisma.deliveryAttempt.update({
        where: { id: attemptId },
        data: {
          status: AttemptStatus.UNKNOWN,
          acceptanceDefinitive: false,
          smtpResponse: response.slice(0, 1000),
          finishedAt: new Date(),
        },
      }),
    ]);
  }

  /** Revert to PENDING for a BullMQ-scheduled retry (pre-acceptance transient). */
  private async revertForRetry(recipientId: number, attemptId: number, response: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: {
          status: RecipientStatus.PENDING,
          enqueueState: EnqueueState.QUEUED,
          leaseOwner: null,
          leaseExpiresAt: null,
          attemptStartedAt: null,
        },
      }),
      this.prisma.deliveryAttempt.update({
        where: { id: attemptId },
        data: {
          status: AttemptStatus.FAILED,
          acceptanceDefinitive: true,
          smtpResponse: response.slice(0, 1000),
          finishedAt: new Date(),
        },
      }),
    ]);
  }

  private async handleSendError(
    job: Job<DeliveryJobData>,
    recipientId: number,
    attemptId: number,
    attemptNumber: number,
    err: unknown,
  ): Promise<void> {
    const message = (err as Error)?.message ?? String(err);
    const c = classifyError(err, {
      nonRetryableCodes: this.config.retry.nonRetryableCodes,
      uncertainCodes: this.config.retry.uncertainCodes,
    });

    if (c.outcome === 'UNCERTAIN') {
      // Acceptance may have occurred -> DELIVERY_UNKNOWN, never auto-retried.
      await this.finalizeUnknown(recipientId, attemptId, message);
      return;
    }

    if (c.outcome === 'NON_RETRYABLE') {
      await this.finalizeFailed(recipientId, attemptId, c.failureReason, message);
      return;
    }

    // RETRYABLE: retry until the max attempt, then terminal FAILED (never left
    // pending). attemptNumber is 1-based (== deliveryAttemptCount for this try).
    if (attemptNumber >= this.config.retry.maxDeliveryAttempts) {
      await this.finalizeFailed(
        recipientId,
        attemptId,
        DeliveryFailureReason.RETRIES_EXHAUSTED,
        message,
      );
      return;
    }
    // More attempts allowed: revert to pending and let BullMQ retry with backoff.
    await this.revertForRetry(recipientId, attemptId, message);
    (err as { __retry?: boolean }).__retry = true;
  }
}
