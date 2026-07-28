/**
 * Typed application configuration loaded from environment.
 *
 * Every value here is a CONSERVATIVE STARTING VALUE (Constitution VI/VII) — it
 * is not a trusted performance value until observed at each scale. Defaults must
 * be safe, not fast.
 */

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

function str(value: string | undefined, fallback: string): string {
  return value === undefined || value.trim() === '' ? fallback : value;
}

function csv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value.trim() === '') return fallback;
  return value
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  db: { connectMaxRetries: number; connectBackoffMs: number };
  redis: { host: string; port: number; connectMaxRetries: number; connectBackoffMs: number };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    pool: boolean;
    maxConnections: number;
    maxMessages: number;
    connectionTimeout: number;
    greetingTimeout: number;
    socketTimeout: number;
    from: string;
  };
  preparation: { batchSize: number };
  dispatch: { enqueueBatchSize: number; maxBufferedQueueJobs: number };
  workers: {
    count: number;
    concurrency: number;
    rateLimitMax: number;
    rateLimitDurationMs: number;
  };
  retry: {
    maxDeliveryAttempts: number;
    backoffMs: number;
    nonRetryableCodes: string[];
    uncertainCodes: string[];
  };
  lease: { heartbeatMs: number; stalenessMs: number; maintenanceIntervalMs: number };
  queueRetention: {
    removeOnCompleteAgeS: number;
    removeOnCompleteCount: number;
    removeOnFailAgeS: number;
    removeOnFailCount: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: num(env.PORT, 3000),
    databaseUrl: str(env.DATABASE_URL, ''),
    db: {
      connectMaxRetries: num(env.DB_CONNECT_MAX_RETRIES, 10),
      connectBackoffMs: num(env.DB_CONNECT_BACKOFF_MS, 1000),
    },
    redis: {
      host: str(env.REDIS_HOST, 'redis'),
      port: num(env.REDIS_PORT, 6379),
      connectMaxRetries: num(env.REDIS_CONNECT_MAX_RETRIES, 10),
      connectBackoffMs: num(env.REDIS_CONNECT_BACKOFF_MS, 1000),
    },
    smtp: {
      host: str(env.SMTP_HOST, 'mailpit'),
      port: num(env.SMTP_PORT, 1025),
      secure: bool(env.SMTP_SECURE, false),
      user: env.SMTP_USER && env.SMTP_USER.trim() !== '' ? env.SMTP_USER : undefined,
      password:
        env.SMTP_PASSWORD && env.SMTP_PASSWORD.trim() !== '' ? env.SMTP_PASSWORD : undefined,
      pool: bool(env.SMTP_POOL, true),
      maxConnections: num(env.SMTP_MAX_CONNECTIONS, 5),
      maxMessages: num(env.SMTP_MAX_MESSAGES, 100),
      connectionTimeout: num(env.SMTP_CONNECTION_TIMEOUT_MS, 10000),
      greetingTimeout: num(env.SMTP_GREETING_TIMEOUT_MS, 10000),
      socketTimeout: num(env.SMTP_SOCKET_TIMEOUT_MS, 20000),
      from: str(env.MAIL_FROM, 'dry-run@mailblast.local'),
    },
    preparation: { batchSize: num(env.PREPARATION_BATCH_SIZE, 500) },
    dispatch: {
      enqueueBatchSize: num(env.DELIVERY_ENQUEUE_BATCH_SIZE, 500),
      maxBufferedQueueJobs: num(env.MAX_BUFFERED_QUEUE_JOBS, 5000),
    },
    workers: {
      count: num(env.WORKER_COUNT, 1),
      concurrency: num(env.WORKER_CONCURRENCY, 5),
      rateLimitMax: num(env.DELIVERY_RATE_LIMIT_MAX, 50),
      rateLimitDurationMs: num(env.DELIVERY_RATE_LIMIT_DURATION_MS, 1000),
    },
    retry: {
      maxDeliveryAttempts: num(env.MAX_DELIVERY_ATTEMPTS, 3),
      backoffMs: num(env.RETRY_BACKOFF_MS, 2000),
      nonRetryableCodes: csv(env.NON_RETRYABLE_SMTP_CODES, ['EENVELOPE', 'EMESSAGE']),
      uncertainCodes: csv(env.UNCERTAIN_SMTP_CODES, ['ETIMEDOUT', 'ESOCKET']),
    },
    lease: {
      heartbeatMs: num(env.LEASE_HEARTBEAT_MS, 5000),
      stalenessMs: num(env.LEASE_STALENESS_MS, 30000),
      maintenanceIntervalMs: num(env.MAINTENANCE_INTERVAL_MS, 5000),
    },
    queueRetention: {
      removeOnCompleteAgeS: num(env.REMOVE_ON_COMPLETE_AGE_S, 3600),
      removeOnCompleteCount: num(env.REMOVE_ON_COMPLETE_COUNT, 1000),
      removeOnFailAgeS: num(env.REMOVE_ON_FAIL_AGE_S, 86400),
      removeOnFailCount: num(env.REMOVE_ON_FAIL_COUNT, 5000),
    },
  };
}

export const APP_CONFIG = 'APP_CONFIG';
