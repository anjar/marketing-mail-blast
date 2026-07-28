import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/domain-exception.filter';
import { enableBigIntJson } from '../../src/common/serialization';

/**
 * Integration tests require real infra. They run only when INTEGRATION=1 (the
 * npm `test:integration` script sets the infra env). Otherwise they are skipped
 * so `npm test` stays green without Docker/Podman.
 */
export const integrationEnabled = process.env.INTEGRATION === '1';
export const describeIntegration = integrationEnabled ? describe : describe.skip;

export function prismaClient(): PrismaClient {
  return new PrismaClient();
}

export async function resetDb(prisma: PrismaClient): Promise<void> {
  // Order respects FKs.
  await prisma.deliveryAttempt.deleteMany({});
  await prisma.campaignRecipient.deleteMany({});
  await prisma.campaign.deleteMany({});
  await prisma.recipient.deleteMany({});
}

export async function seedRecipients(
  prisma: PrismaClient,
  rows: Array<{ email: string | null; name: string | null }>,
): Promise<void> {
  await prisma.recipient.createMany({ data: rows });
}

export async function createTestApp(): Promise<INestApplication> {
  enableBigIntJson();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.enableShutdownHooks();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.init();
  return app;
}

/** Poll until predicate true or timeout. */
export async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 30000,
  intervalMs = 250,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

export async function flushRedis(): Promise<void> {
  const IORedis = (await import('ioredis')).default;
  const client = new IORedis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null,
  });
  await client.flushall();
  await client.quit();
}

export async function mailpitReset(): Promise<void> {
  await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' }).catch(() => undefined);
}

export async function mailpitCount(): Promise<number> {
  const res = await fetch('http://localhost:8025/api/v1/messages?limit=1');
  const body = (await res.json()) as { total: number };
  return body.total;
}
