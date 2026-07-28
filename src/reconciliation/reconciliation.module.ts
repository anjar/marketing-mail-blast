import { Module } from '@nestjs/common';
import { CampaignModule } from '../campaign/campaign.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { OrphanSweepService } from './orphan-sweep.service';
import { MaintenanceProcessor } from './maintenance.processor';
import { StartupReconciliationService } from './startup-reconciliation.service';

@Module({
  imports: [CampaignModule, DispatchModule],
  providers: [OrphanSweepService, MaintenanceProcessor, StartupReconciliationService],
  exports: [StartupReconciliationService],
})
export class ReconciliationModule {}
