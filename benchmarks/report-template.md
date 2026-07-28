# Benchmark Report — Bulk Email Dry-Run Sender

> One filled copy per scale run. A run is valid ONLY for the recorded environment
> and configuration (Constitution VII). Large-scale numbers reflect the whole
> local pipeline **including Mailpit SMTP ingestion + storage** — they are NOT
> expected production email-provider throughput.

## Run identity

- Date / time:
- Operator:
- Git commit:
- Scale profile (recipients): ☐ 1,000 ☐ 10,000 ☐ 100,000 ☐ 1,000,000 ☐ >1,000,000 (value: ____)

## Dataset

- Recipient count:
- Valid count:
- Invalid count:
- Duplicate (normalized) count:
- Profile: ☐ throughput (valid/unique) ☐ validation fixtures
- Subject size (chars):
- Body size (chars):

## Configuration (record the actual values used)

| Setting | Value |
|---|---|
| PREPARATION_BATCH_SIZE | |
| DELIVERY_ENQUEUE_BATCH_SIZE | |
| MAX_BUFFERED_QUEUE_JOBS (backlog cap) | |
| WORKER_COUNT | |
| WORKER_CONCURRENCY | |
| DELIVERY_RATE_LIMIT_MAX / DURATION_MS | |
| MAX_DELIVERY_ATTEMPTS | |
| RETRY_BACKOFF_MS | |
| SMTP_MAX_CONNECTIONS | |
| SMTP_MAX_MESSAGES | |
| LEASE_STALENESS_MS | |

## Infrastructure / resource limits

- Host CPU / cores:
- Host memory:
- PostgreSQL limits (cpu/mem/connections):
- Redis limits (cpu/mem/maxmemory policy):
- Mailpit config: SMTP port ____, web/API port ____, retention (MP_MAX_MESSAGES) ____, storage (MP_DATABASE path + volume) ____, pruning enabled? ____

## Results

- Total duration:
- Preparation throughput (recipients/s):
- Delivery throughput (recipients/s):
- Outcome counts:
  - pending (should be 0 at completion):
  - rejected: (by reason: EMAIL_MISSING __, EMAIL_INVALID_FORMAT __, DUPLICATE_EMAIL __)
  - sent:
  - failed: (by reason: SMTP_REJECTED __, RETRIES_EXHAUSTED __, other __)
  - delivery_unknown:
- **Duplicate-send count** (must be 0):
- Total delivery attempts:
- Reconciliation holds (total = pending+rejected+sent+failed+unknown)? ☐ yes ☐ no

## Observations

- CPU:
- Memory:
- Disk:
- PostgreSQL (connections, slow queries, table/index sizes):
- Redis (memory, queue depth vs backlog cap):
- Mailpit (ingestion rate, pruning behavior):

## Verdict

- Correctness / reconciliation / duplicate-delivery / recovery defects? ☐ none ☐ (describe)
- Config values trusted at this scale? ☐ yes ☐ no
- Cleared to attempt the next larger scale? ☐ yes ☐ no (a larger run must NOT begin
  while a smaller run has unresolved defects — SC-012)
