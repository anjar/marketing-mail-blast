import { Injectable, Logger } from '@nestjs/common';
import { CampaignStatus, EnqueueState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProgressService } from '../progress/progress.service';
import { CampaignCountersService } from './campaign-counters.service';
import { countsReconcile, terminalCampaignStatus } from './status-rules';

/**
 * Campaign completion (FR-030..033). A campaign may become terminal only when:
 *  - no recipients remain pending (PENDING or IN_PROGRESS);
 *  - no accepted work remains undispatched or in flight
 *    (no enqueueState in READY_TO_QUEUE / QUEUED / PROCESSING);
 *  - counters reconcile (total = pending + rejected + sent + failed + unknown).
 * The transition is an atomic conditional update so multiple workers cannot
 * complete the campaign inconsistently.
 */
@Injectable()
export class CompletionService {
  private readonly logger = new Logger(CompletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly progress: ProgressService,
    private readonly counters: CampaignCountersService,
  ) {}

  /** Returns the terminal status if the campaign completed on this call, else null. */
  async tryComplete(campaignId: string): Promise<CampaignStatus | null> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!campaign || campaign.status !== CampaignStatus.RUNNING) return null;

    const counts = await this.progress.deriveCounts(campaignId);

    // Any pending recipient -> stay active (FR-030).
    if (counts.pending > 0) return null;

    // Any accepted work still undispatched / queued / processing -> not done.
    const inFlight = await this.prisma.campaignRecipient.count({
      where: {
        campaignId,
        enqueueState: {
          in: [EnqueueState.READY_TO_QUEUE, EnqueueState.QUEUED, EnqueueState.PROCESSING],
        },
      },
    });
    if (inFlight > 0) return null;

    // Counters must reconcile (FR-033). Refresh persisted counters first.
    await this.counters.recompute(campaignId);
    if (!countsReconcile(counts)) {
      this.logger.error(
        `Completion refused for ${campaignId}: counters do not reconcile ${JSON.stringify(counts)}`,
      );
      return null;
    }

    const target = terminalCampaignStatus(counts);
    if (!target) return null;

    // Atomic conditional transition RUNNING -> terminal (only one worker wins).
    const updated = await this.prisma.campaign.updateMany({
      where: { id: campaignId, status: CampaignStatus.RUNNING },
      data: { status: target, completedAt: new Date() },
    });
    if (updated.count === 0) return null;

    this.logger.log(`Campaign ${campaignId} completed as ${target}`);
    return target;
  }
}
