import { Inject, Injectable, Logger } from '@nestjs/common';
import { CampaignStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import {
  MAINTENANCE_QUEUE,
  MaintenanceJobData,
  PREPARATION_QUEUE,
  PreparationJobData,
  maintenanceJobId,
  preparationJobId,
} from '../queue/queue.constants';

/**
 * Startup reconciliation (FR-035, T056). On boot it detects active campaigns and
 * restores their missing operational work — Redis/BullMQ state is reconstructible
 * from PostgreSQL, so nothing is lost across a restart:
 *  - PREPARING campaign -> re-enqueue the (deterministic, resumable) prep job.
 *  - Any active campaign -> ensure the repeatable maintenance job exists so
 *    dispatch / orphan-sweep / completion resume.
 * Terminal outcomes on individual recipients are never touched.
 */
@Injectable()
export class StartupReconciliationService {
  private readonly logger = new Logger(StartupReconciliationService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PREPARATION_QUEUE) private readonly preparationQueue: Queue<PreparationJobData>,
    @Inject(MAINTENANCE_QUEUE) private readonly maintenanceQueue: Queue<MaintenanceJobData>,
    private readonly prisma: PrismaService,
  ) {}

  async reconcile(): Promise<void> {
    const active = await this.prisma.campaign.findMany({
      where: { status: { in: [CampaignStatus.PREPARING, CampaignStatus.RUNNING] } },
      select: { id: true, status: true },
    });
    if (active.length === 0) {
      this.logger.log('Startup reconciliation: no active campaigns');
      return;
    }

    for (const c of active) {
      if (c.status === CampaignStatus.PREPARING) {
        await this.preparationQueue.add(
          'prepare',
          { campaignId: c.id },
          { jobId: preparationJobId(c.id) },
        );
      }
      await this.maintenanceQueue.add(
        'maintenance',
        { campaignId: c.id },
        {
          jobId: maintenanceJobId(c.id),
          repeat: { every: this.config.lease.maintenanceIntervalMs },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      this.logger.log(`Startup reconciliation: restored work for campaign ${c.id} (${c.status})`);
    }
  }
}
