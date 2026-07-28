import { Injectable, Logger } from '@nestjs/common';
import { EnqueueState, RecipientStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reconciles orphaned in-flight attempts (FR-022b/c). An IN_PROGRESS recipient
 * whose lease has expired past the staleness timeout is the interrupted-during-
 * send case: acceptance cannot be positively confirmed, so it resolves to
 * DELIVERY_UNKNOWN. It is NEVER silently marked SENT/FAILED and NEVER auto-resent.
 * A record with a LIVE lease (leaseExpiresAt in the future) is left untouched.
 */
@Injectable()
export class OrphanSweepService {
  private readonly logger = new Logger(OrphanSweepService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Sweep expired-lease IN_PROGRESS rows for a campaign. Returns count reconciled. */
  async sweepCampaign(campaignId: string): Promise<number> {
    const now = new Date();
    const orphans = await this.prisma.campaignRecipient.findMany({
      where: {
        campaignId,
        status: RecipientStatus.IN_PROGRESS,
        leaseExpiresAt: { lt: now },
      },
      select: { id: true },
    });
    if (orphans.length === 0) return 0;

    for (const o of orphans) {
      // Conditional: only if still IN_PROGRESS with an expired lease (a worker
      // may have renewed or terminated it in between).
      const updated = await this.prisma.campaignRecipient.updateMany({
        where: {
          id: o.id,
          status: RecipientStatus.IN_PROGRESS,
          leaseExpiresAt: { lt: new Date() },
        },
        data: {
          status: RecipientStatus.DELIVERY_UNKNOWN,
          enqueueState: EnqueueState.TERMINAL,
          terminalAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      if (updated.count > 0) {
        await this.prisma.deliveryAttempt.updateMany({
          where: { campaignRecipientId: o.id, finishedAt: null },
          data: { status: 'UNKNOWN', acceptanceDefinitive: false, finishedAt: new Date() },
        });
      }
    }

    this.logger.warn(`Reconciled ${orphans.length} orphaned recipient(s) -> DELIVERY_UNKNOWN`);
    return orphans.length;
  }
}
