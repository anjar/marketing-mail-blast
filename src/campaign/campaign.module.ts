import { Module } from '@nestjs/common';
import { RecipientModule } from '../recipient/recipient.module';
import { ProgressModule } from '../progress/progress.module';
import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';
import { CompletionService } from './completion.service';

@Module({
  imports: [RecipientModule, ProgressModule],
  controllers: [CampaignController],
  providers: [CampaignService, CompletionService],
  exports: [CampaignService, CompletionService],
})
export class CampaignModule {}
