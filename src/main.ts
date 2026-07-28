import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfig } from './config/app-config';
import { DomainExceptionFilter } from './common/domain-exception.filter';
import { enableBigIntJson } from './common/serialization';
import { StartupReconciliationService } from './reconciliation/startup-reconciliation.service';

async function bootstrap(): Promise<void> {
  enableBigIntJson();
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // Graceful shutdown: Nest calls onApplicationShutdown / onModuleDestroy hooks
  // on SIGTERM/SIGINT, which drain BullMQ workers, close the SMTP pool, Redis,
  // and Prisma (see each module's lifecycle hooks).
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());

  const config = app.get<AppConfig>(APP_CONFIG);

  // Startup reconciliation: restore missing preparation/dispatch/completion work
  // for any campaign left active by a previous run (FR-035).
  const reconciler = app.get(StartupReconciliationService);
  await reconciler.reconcile();

  await app.listen(config.port, '0.0.0.0');
  logger.log(`Listening on :${config.port}`);
  logger.log(`Bull Board (read-only) at /internal/queues`);
}

void bootstrap();
