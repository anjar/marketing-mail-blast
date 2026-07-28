import { join } from 'path';
import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AppConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { MailModule } from './mail/mail.module';
import { HealthModule } from './health/health.module';
import { BullBoardModule } from './bull-board/bull-board.module';
import { RecipientModule } from './recipient/recipient.module';
import { CampaignModule } from './campaign/campaign.module';
import { PreparationModule } from './preparation/preparation.module';
import { DispatchModule } from './dispatch/dispatch.module';
import { DeliveryModule } from './delivery/delivery.module';
import { ProgressModule } from './progress/progress.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    QueueModule,
    MailModule,
    // Serve the static frontend from public/. API, health, and Bull Board routes
    // are excluded so the SPA fallback never shadows them.
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'public'),
      serveRoot: '/',
      exclude: ['/api/{*splat}', '/health', '/ready', '/internal/{*splat}'],
    }),
    HealthModule,
    BullBoardModule,
    RecipientModule,
    CampaignModule,
    PreparationModule,
    DispatchModule,
    DeliveryModule,
    ProgressModule,
    ReconciliationModule,
  ],
})
export class AppModule {}
