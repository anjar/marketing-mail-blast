import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProgressService } from '../progress/progress.service';

/**
 * Refreshes the Campaign counter columns from CampaignRecipient rows. Counters
 * are an optimization for cheap reads and the completion gate; they are always
 * reproducible from recipient rows (Constitution V). Progress reads derive
 * directly from rows, so a stale counter can never corrupt user-facing progress.
 */
@Injectable()
export class CampaignCountersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly progress: ProgressService,
  ) {}

  async recompute(campaignId: string): Promise<void> {
    const counts = await this.progress.deriveCounts(campaignId);
    const totalAttempts = await this.prisma.deliveryAttempt.count({
      where: { campaignRecipient: { campaignId } },
    });
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        totalCount: counts.total,
        pendingCount: counts.pending,
        rejectedCount: counts.rejected,
        sentCount: counts.sent,
        failedCount: counts.failed,
        deliveryUnknownCount: counts.deliveryUnknown,
        totalDeliveryAttemptCount: totalAttempts,
      },
    });
  }
}
