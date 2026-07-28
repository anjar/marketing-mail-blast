import IORedis, { Redis } from 'ioredis';
import { AppConfig } from '../config/app-config';

/**
 * Create a Redis connection for a BullMQ Worker. BullMQ recommends a DEDICATED
 * blocking connection per worker (workers issue blocking commands). Sharing one
 * connection between queues and workers can also deadlock graceful shutdown, so
 * each worker owns and closes its own connection.
 */
export function createWorkerConnection(config: AppConfig): Redis {
  return new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: null,
  });
}
