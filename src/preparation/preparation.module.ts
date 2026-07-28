import { Module } from '@nestjs/common';
import { RecipientModule } from '../recipient/recipient.module';
import { ProgressModule } from '../progress/progress.module';
import { PreparationProcessor } from './preparation.processor';

@Module({
  imports: [RecipientModule, ProgressModule],
  providers: [PreparationProcessor],
})
export class PreparationModule {}
