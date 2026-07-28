import { Inject, Injectable, Logger } from '@nestjs/common';
import { Campaign, CampaignStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { RecipientService } from '../recipient/recipient.service';
import { CampaignActiveError, isActiveCampaignViolation } from '../common/errors';
import {
  PREPARATION_QUEUE,
  PreparationJobData,
  preparationJobId,
} from '../queue/queue.constants';
import { ACTIVE_CAMPAIGN_STATUSES } from './status-rules';

/** Public campaign summary (contracts/openapi.yaml CampaignSummary). */
export interface CampaignSummary {
  id: string;
  status: CampaignStatus;
  startedAt: Date;
  completedAt: Date | null;
}

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recipients: RecipientService,
    @Inject(PREPARATION_QUEUE) private readonly preparationQueue: Queue<PreparationJobData>,
  ) {}

  /**
   * Create exactly one campaign. Correctness of the single-active invariant
   * relies on the PostgreSQL partial unique index `one_active_campaign`
   * (Constitution II); the pre-check is only a friendly fast-path. A losing
   * concurrent insert raises the unique violation -> CampaignActiveError -> 409.
   */
  async create(subject: string, body: string): Promise<CampaignSummary> {
    // Friendly fast-path (not the enforcement).
    const existing = await this.prisma.campaign.findFirst({
      where: { status: { in: ACTIVE_CAMPAIGN_STATUSES } },
      select: { id: true },
    });
    if (existing) {
      throw new CampaignActiveError();
    }

    // Stable snapshot upper bound captured at acceptance (FR-004).
    const snapshotMax = await this.recipients.maxRecipientId();
    const total = await this.prisma.recipient.count({ where: { id: { lte: snapshotMax } } });

    let campaign: Campaign;
    try {
      campaign = await this.prisma.campaign.create({
        data: {
          subject,
          body,
          status: CampaignStatus.PREPARING,
          snapshotMaxRecipientId: snapshotMax,
          preparationCursor: 0,
          totalCount: total,
          pendingCount: total,
        },
      });
    } catch (err) {
      if (isActiveCampaignViolation(err)) {
        throw new CampaignActiveError();
      }
      throw err;
    }

    // Kick off preparation. Deterministic job id makes a duplicate submit/retry a
    // no-op at the queue level; the committed campaign row is authoritative.
    await this.preparationQueue.add(
      'prepare',
      { campaignId: campaign.id },
      { jobId: preparationJobId(campaign.id) },
    );

    this.logger.log(`Created campaign ${campaign.id} (snapshotMax=${snapshotMax}, total=${total})`);
    return this.toSummary(campaign);
  }

  /** Current active campaign, or null when none (GET /api/campaigns/active). */
  async getActive(): Promise<CampaignSummary | null> {
    const campaign = await this.prisma.campaign.findFirst({
      where: { status: { in: ACTIVE_CAMPAIGN_STATUSES } },
      orderBy: { startedAt: 'desc' },
    });
    return campaign ? this.toSummary(campaign) : null;
  }

  private toSummary(c: Campaign): CampaignSummary {
    return { id: c.id, status: c.status, startedAt: c.startedAt, completedAt: c.completedAt };
  }
}
