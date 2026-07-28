import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Inject, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DELIVERY_QUEUE, MAINTENANCE_QUEUE, PREPARATION_QUEUE } from '../queue/queue.constants';

export const BULL_BOARD_BASE_PATH = '/internal/queues';

/**
 * Read-only Bull Board for queue observability ONLY (waiting/active/delayed/
 * retries/completed/failed). It is NEVER the source of user-facing campaign
 * progress, and — since auth is out of scope — must not be exposed as a
 * production-public admin interface (see plan Bull Board section).
 */
@Module({})
export class BullBoardModule implements NestModule {
  private readonly serverAdapter: ExpressAdapter;

  constructor(
    @Inject(PREPARATION_QUEUE) preparationQueue: Queue,
    @Inject(DELIVERY_QUEUE) deliveryQueue: Queue,
    @Inject(MAINTENANCE_QUEUE) maintenanceQueue: Queue,
  ) {
    this.serverAdapter = new ExpressAdapter();
    this.serverAdapter.setBasePath(BULL_BOARD_BASE_PATH);
    createBullBoard({
      queues: [
        new BullMQAdapter(preparationQueue, { readOnlyMode: true }),
        new BullMQAdapter(deliveryQueue, { readOnlyMode: true }),
        new BullMQAdapter(maintenanceQueue, { readOnlyMode: true }),
      ],
      serverAdapter: this.serverAdapter,
      options: { uiConfig: { boardTitle: 'Mailblast Queues (read-only)' } },
    });
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(this.serverAdapter.getRouter()).forRoutes(BULL_BOARD_BASE_PATH);
  }
}
