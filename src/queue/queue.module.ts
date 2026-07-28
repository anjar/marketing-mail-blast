import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis, { Redis } from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import {
  DELIVERY_QUEUE,
  MAINTENANCE_QUEUE,
  PREPARATION_QUEUE,
  QUEUE_DELIVERY,
  QUEUE_MAINTENANCE,
  QUEUE_PREPARATION,
  REDIS_CONNECTION,
} from './queue.constants';

function createRedis(config: AppConfig): Redis {
  const logger = new Logger('Redis');
  const client = new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    // BullMQ requirement.
    maxRetriesPerRequest: null,
    // Bounded-backoff initial + ongoing reconnect (don't trust depends_on alone).
    retryStrategy: (times) => {
      if (times > config.redis.connectMaxRetries) return null;
      const delay = config.redis.connectBackoffMs * times;
      logger.warn(`Redis connect attempt ${times} failed; retrying in ${delay}ms`);
      return delay;
    },
  });
  client.on('error', (err) => logger.error(`Redis error: ${err.message}`));
  return client;
}

/**
 * Registers the shared ioredis connection and the three logical queues:
 * preparation, delivery, maintenance. Queues are producers here; workers are
 * started by their own modules against the same connection.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CONNECTION,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createRedis(config),
    },
    {
      provide: PREPARATION_QUEUE,
      inject: [REDIS_CONNECTION],
      useFactory: (connection: Redis) => new Queue(QUEUE_PREPARATION, { connection }),
    },
    {
      provide: DELIVERY_QUEUE,
      inject: [REDIS_CONNECTION],
      useFactory: (connection: Redis) => new Queue(QUEUE_DELIVERY, { connection }),
    },
    {
      provide: MAINTENANCE_QUEUE,
      inject: [REDIS_CONNECTION],
      useFactory: (connection: Redis) => new Queue(QUEUE_MAINTENANCE, { connection }),
    },
  ],
  exports: [REDIS_CONNECTION, PREPARATION_QUEUE, DELIVERY_QUEUE, MAINTENANCE_QUEUE],
})
export class QueueModule implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueModule.name);

  constructor(
    @Inject(REDIS_CONNECTION) private readonly connection: Redis,
    @Inject(PREPARATION_QUEUE) private readonly preparationQueue: Queue,
    @Inject(DELIVERY_QUEUE) private readonly deliveryQueue: Queue,
    @Inject(MAINTENANCE_QUEUE) private readonly maintenanceQueue: Queue,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    // Close queues, then the shared Redis connection, so no open handles leak
    // (graceful shutdown; also keeps the test runner from hanging).
    await Promise.allSettled([
      this.preparationQueue.close(),
      this.deliveryQueue.close(),
      this.maintenanceQueue.close(),
    ]);
    await this.connection.quit().catch(() => undefined);
    this.logger.log('Queue module shut down');
  }
}
