import { Controller, Get, Inject, Res } from '@nestjs/common';
import { Response } from 'express';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CONNECTION } from '../queue/queue.constants';

/**
 * Liveness and readiness endpoints.
 * - GET /health : process is alive (always 200 if the event loop responds).
 * - GET /ready  : PostgreSQL AND Redis reachable -> 200, else 503.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res() res: Response): Promise<void> {
    const checks: Record<string, boolean> = { postgres: false, redis: false };
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.postgres = true;
    } catch {
      checks.postgres = false;
    }
    try {
      const pong = await this.redis.ping();
      checks.redis = pong === 'PONG';
    } catch {
      checks.redis = false;
    }

    const ready = checks.postgres && checks.redis;
    if (ready) {
      res.status(200).json({ status: 'ready', checks });
    } else {
      res.status(503).json({ error: 'NOT_READY', message: 'Dependency not ready', checks });
    }
  }
}
