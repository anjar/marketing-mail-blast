import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../config/app-config';

/**
 * PrismaService with a bounded-backoff initial connect. The application must not
 * trust container startup order (compose depends_on); it retries the first DB
 * connection itself.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  async onModuleInit(): Promise<void> {
    const { connectMaxRetries, connectBackoffMs } = this.config.db;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await this.$connect();
        this.logger.log('Connected to PostgreSQL');
        return;
      } catch (err) {
        attempt += 1;
        if (attempt > connectMaxRetries) {
          this.logger.error(`PostgreSQL connect failed after ${attempt} attempts`);
          throw err;
        }
        const delay = connectBackoffMs * attempt;
        this.logger.warn(`PostgreSQL connect attempt ${attempt} failed; retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
