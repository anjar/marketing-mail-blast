import { Injectable } from '@nestjs/common';
import {
  CampaignStatus,
  DeliveryFailureReason,
  RecipientStatus,
  RejectionReason,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignNotFoundError } from '../common/errors';
import { CampaignCounts, countsReconcile } from '../campaign/status-rules';

export interface CampaignProgress {
  id: string;
  status: CampaignStatus;
  total: number;
  pending: number;
  rejected: number;
  sent: number;
  failed: number;
  deliveryUnknown: number;
  totalDeliveryAttempts: number;
  rejectedByReason: Record<string, number>;
  failedByReason: Record<string, number>;
  startedAt: Date;
  completedAt: Date | null;
}

/**
 * Campaign progress derived from PostgreSQL CampaignRecipient rows — the
 * authoritative source (Constitution V, FR-029). Never Redis, never Bull Board.
 */
@Injectable()
export class ProgressService {
  constructor(private readonly prisma: PrismaService) {}

  /** Roll-up counts computed directly from recipient rows (reproducible). */
  async deriveCounts(campaignId: string): Promise<CampaignCounts> {
    const grouped = await this.prisma.campaignRecipient.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: { _all: true },
    });
    const byStatus = new Map<RecipientStatus, number>();
    for (const g of grouped) byStatus.set(g.status, g._count._all);

    const pending =
      (byStatus.get(RecipientStatus.PENDING) ?? 0) +
      (byStatus.get(RecipientStatus.IN_PROGRESS) ?? 0);
    const rejected = byStatus.get(RecipientStatus.REJECTED) ?? 0;
    const sent = byStatus.get(RecipientStatus.SENT) ?? 0;
    const failed = byStatus.get(RecipientStatus.FAILED) ?? 0;
    const deliveryUnknown = byStatus.get(RecipientStatus.DELIVERY_UNKNOWN) ?? 0;
    const total = pending + rejected + sent + failed + deliveryUnknown;

    return { total, pending, rejected, sent, failed, deliveryUnknown };
  }

  async getProgress(campaignId: string): Promise<CampaignProgress> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new CampaignNotFoundError();

    const counts = await this.deriveCounts(campaignId);

    const rejectedGroups = await this.prisma.campaignRecipient.groupBy({
      by: ['rejectionReason'],
      where: { campaignId, status: RecipientStatus.REJECTED },
      _count: { _all: true },
    });
    const failedGroups = await this.prisma.campaignRecipient.groupBy({
      by: ['deliveryFailureReason'],
      where: { campaignId, status: RecipientStatus.FAILED },
      _count: { _all: true },
    });

    const rejectedByReason: Record<string, number> = {};
    for (const g of rejectedGroups) {
      const key = (g.rejectionReason ?? 'UNSPECIFIED') as RejectionReason | 'UNSPECIFIED';
      rejectedByReason[key] = g._count._all;
    }
    const failedByReason: Record<string, number> = {};
    for (const g of failedGroups) {
      const key = (g.deliveryFailureReason ?? 'UNSPECIFIED') as DeliveryFailureReason | 'UNSPECIFIED';
      failedByReason[key] = g._count._all;
    }

    const totalDeliveryAttempts = await this.prisma.deliveryAttempt.count({
      where: { campaignRecipient: { campaignId } },
    });

    return {
      id: campaign.id,
      status: campaign.status,
      total: counts.total,
      pending: counts.pending,
      rejected: counts.rejected,
      sent: counts.sent,
      failed: counts.failed,
      deliveryUnknown: counts.deliveryUnknown,
      totalDeliveryAttempts,
      rejectedByReason,
      failedByReason,
      startedAt: campaign.startedAt,
      completedAt: campaign.completedAt,
    };
  }

  /** True when the reconciliation invariant holds (FR-033). */
  reconciles(counts: CampaignCounts): boolean {
    return countsReconcile(counts);
  }
}
