import { Module } from '@nestjs/common';
import { RecipientService } from './recipient.service';

@Module({
  providers: [RecipientService],
  exports: [RecipientService],
})
export class RecipientModule {}
