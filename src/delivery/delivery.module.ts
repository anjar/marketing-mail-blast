import { Module } from '@nestjs/common';
import { DeliveryProcessor } from './delivery.processor';

@Module({
  providers: [DeliveryProcessor],
})
export class DeliveryModule {}
