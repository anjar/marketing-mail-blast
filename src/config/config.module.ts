import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './app-config';

/**
 * Global config module. Validates + exposes the typed AppConfig via the
 * APP_CONFIG token so any provider can inject conservative, documented defaults.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => {
        const config = loadConfig();
        if (!config.databaseUrl) {
          throw new Error('DATABASE_URL is required');
        }
        if (config.workers.concurrency > config.smtp.maxConnections * 4) {
          // Not fatal, but worth surfacing: worker concurrency far above SMTP pool
          // capacity just piles jobs into Nodemailer's internal queue.
          // eslint-disable-next-line no-console
          console.warn(
            `[config] WORKER_CONCURRENCY (${config.workers.concurrency}) greatly exceeds ` +
              `SMTP_MAX_CONNECTIONS (${config.smtp.maxConnections}); coordinate these per plan.`,
          );
        }
        return config;
      },
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
