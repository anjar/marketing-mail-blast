import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import {
  createTestApp,
  describeIntegration,
  flushRedis,
  prismaClient,
  resetDb,
  seedRecipients,
} from './helpers';

/**
 * User Story 1 — submission + single-active enforcement (T020, T021).
 */
describeIntegration('Campaign submission', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = prismaClient();
    await flushRedis();
    await resetDb(prisma);
    await seedRecipients(prisma, [
      { email: 'a@example.com', name: 'A' },
      { email: 'b@example.com', name: 'B' },
    ]);
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('creates exactly one campaign and fixes a snapshot', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/campaigns')
      .send({ subject: 'Hello', body: 'Hi {{name}}' })
      .expect(201);
    expect(res.body.id).toBeDefined();
    expect(['PREPARING', 'RUNNING']).toContain(res.body.status);

    const campaign = await prisma.campaign.findUnique({ where: { id: res.body.id } });
    expect(campaign?.snapshotMaxRecipientId).toBeGreaterThan(0n);
  });

  it('rejects a second submit while one is active with 409', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/campaigns')
      .send({ subject: 'Second', body: 'x' })
      .expect(409);
    expect(res.body.error).toBe('CAMPAIGN_ACTIVE');
  });

  it('rejects whitespace-only subject/body with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/campaigns')
      .send({ subject: '   ', body: '   ' })
      .expect(400);
  });
});

describeIntegration('Concurrent campaign submission', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = prismaClient();
    await flushRedis();
    await resetDb(prisma);
    await seedRecipients(prisma, [{ email: 'c@example.com', name: 'C' }]);
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('creates exactly one campaign under concurrent submits; rest get 409', async () => {
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }).map(() =>
        request(app.getHttpServer())
          .post('/api/campaigns')
          .send({ subject: 'Race', body: 'y' })
          .then((r) => r.status),
      ),
    );
    const created = results.filter((s) => s === 201).length;
    const conflicts = results.filter((s) => s === 409).length;
    expect(created).toBe(1);
    expect(conflicts).toBe(N - 1);

    const activeCount = await prisma.campaign.count({
      where: { status: { in: ['PREPARING', 'RUNNING'] } },
    });
    expect(activeCount).toBe(1);
  });
});
