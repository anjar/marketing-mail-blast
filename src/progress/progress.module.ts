import { Module } from '@nestjs/common';
import { CampaignCountersService } from '../campaign/campaign-counters.service';
import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';

@Module({
  controllers: [ProgressController],
  providers: [ProgressService, CampaignCountersService],
  exports: [ProgressService, CampaignCountersService],
})
export class ProgressModule {}
