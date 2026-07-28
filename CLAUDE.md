# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A non-production bulk email **dry-run** application (NestJS + TypeScript, single process). One
operator submits a single personalized email campaign against a preloaded recipient dataset of up
to 1,000,000+ records. Dry-run SMTP target is **Mailpit** — no mail ever leaves the machine.

Governing documents, read before making non-trivial changes:
- [`.specify/memory/constitution.md`](.specify/memory/constitution.md) — non-negotiable invariants
  (recipient outcome integrity, single active campaign, idempotency, bounded work, measured
  performance). Any change that conflicts with it needs an explicit documented exception.
- [`specs/001-bulk-email-dryrun/`](specs/001-bulk-email-dryrun/) — `spec.md`, `plan.md`,
  `research.md`, `data-model.md`, `contracts/openapi.yaml`, `quickstart.md`, `tasks.md`.

## Commands

```bash
# Stack (Postgres + Redis + Mailpit + app) — validated with both providers
docker compose up -d          # or: podman compose up -d

# Migrations (app also runs this on boot)
npm run prisma:migrate               # prisma migrate deploy
npm run prisma:migrate:dev           # dev migration authoring
npm run prisma:generate

# Dev server (outside the container, needs DATABASE_URL/REDIS_HOST/SMTP_HOST pointed at localhost)
npm run start:dev
npm run build && npm start

npm run lint
npm run format

# Tests
npm run test:unit                    # pure logic, no infra
npm run test:integration             # needs real Postgres/Redis/Mailpit — see below
npm test                             # both, --runInBand

# Single test file
npx jest --selectProjects unit test/unit/personalization.spec.ts
npx jest --selectProjects integration --runInBand --forceExit test/integration/recovery.spec.ts
```

Integration tests require live infra and env pointed at the host-published ports:

```bash
INTEGRATION=1 \
DATABASE_URL=postgresql://mailblast:mailblast@localhost:5432/mailblast \
REDIS_HOST=localhost SMTP_HOST=localhost \
npm run test:integration
```

Seed/reset recipient data (no local `psql` needed — pipes into the compose `postgres` service):

```bash
cd dummy
./run-seed.sh 00_clear.sql
./run-seed.sh 10_seed_throughput.sql -v scale=1000   # valid unique recipients: 1k/10k/100k/1M
./run-seed.sh 20_seed_validation.sql                 # invalid/missing/duplicate fixtures
./run-seed.sh 30_verify_counts.sql
./run-seed.sh 40_verify_fixtures.sql
./clear-mailpit.sh                                   # clear captured messages via Mailpit API
```
Don't mix `10_seed_throughput` and `20_seed_validation` datasets unless the test explicitly needs both.

## Architecture

**PostgreSQL is the sole business system of record** (Constitution V). Redis/BullMQ hold only
reconstructible operational work — after any crash, queue state can be fully rebuilt from
PostgreSQL rows; nothing authoritative lives only in Redis.

### Pipeline (one campaign, three durable state machines)

```
POST /api/campaigns
  → CampaignService.create()
      - PostgreSQL partial unique index `one_active_campaign` is the actual enforcement of
        "at most one non-terminal campaign" (Constitution II) — the pre-check in code is just
        a friendly fast-path; a losing concurrent insert throws a unique violation -> 409.
      - Snapshot is a captured `snapshotMaxRecipientId` (max Recipient.id at accept time), not a
        copy of rows. Campaign starts in PREPARING.
      - Enqueues one deterministic `prepare_<campaignId>` job.

  → PreparationProcessor (queue: preparation)
      - Keyset-paginates Recipient rows up to snapshotMaxRecipientId (never OFFSET, never full
        scan in memory), persisting `preparationCursor` after each batch so a crash mid-scan
        resumes rather than restarts.
      - For each source row, materializes exactly one CampaignRecipient:
        validate email -> REJECTED (EMAIL_MISSING/EMAIL_INVALID_FORMAT), or
        try to claim it -> unique violation on (campaignId, normalizedEmail) means a duplicate,
        rejected as DUPLICATE_EMAIL pointing at the earliest-id canonical row; otherwise PENDING.
      - On finish: recompute counters, flip PREPARING -> RUNNING, and ensure a repeatable
        maintenance job exists (`maintenance_<campaignId>`, every `MAINTENANCE_INTERVAL_MS`).

  → MaintenanceProcessor (queue: maintenance, repeatable)
      Per tick, for the campaign: sweep orphans, dispatch, then (if RUNNING) try completion.
      Removes its own repeatable job once the campaign reaches a terminal status.

      → OrphanSweepService: an IN_PROGRESS CampaignRecipient with an expired `leaseExpiresAt`
        is the "interrupted during send" case — resolved to DELIVERY_UNKNOWN, attempt marked
        UNKNOWN. A row with a live lease is left untouched (another worker may still own it).

      → DispatchService: finds CampaignRecipient rows still `enqueueState=READY_TO_QUEUE`,
        `addBulk()`s bounded batches of delivery jobs with deterministic ids
        (`deliver_<campaignId>_<recipientId>`), only then marks them QUEUED. Backs off when
        buffered BullMQ job count reaches `MAX_BUFFERED_QUEUE_JOBS` (backpressure).

      → CompletionService.tryComplete(): terminal only when pending count is zero AND no
        recipient still has enqueueState in READY_TO_QUEUE/QUEUED/PROCESSING AND counters
        reconcile (`total = pending + rejected + sent + failed + deliveryUnknown`, checked via
        `countsReconcile()` in status-rules.ts). COMPLETED vs COMPLETED_WITH_ISSUES is decided by
        `terminalCampaignStatus()`. The RUNNING -> terminal transition is a conditional
        `updateMany` so only one concurrent maintenance tick can win it.

  → DeliveryProcessor (queue: delivery, N workers x concurrency, rate-limited)
      One job = one CampaignRecipient. Sequence per job:
        1. Load recipient; if already terminal, no-op (never re-sent — FR-038).
        2. Atomic claim: `updateMany` PENDING -> IN_PROGRESS with a lease (`leaseOwner`,
           `leaseExpiresAt`) — a heartbeat interval renews it every `LEASE_HEARTBEAT_MS` while
           the job runs. If the claim's affected count is 0, another worker already owns it —
           bail out (this is what makes concurrent workers safe).
        3. Create a DeliveryAttempt row BEFORE calling SMTP (audit trail exists even if the
           process dies mid-send).
        4. Send via MailService/Nodemailer; classify the outcome with `outcome-classifier.ts`:
           - accepted -> SENT (attempt SUCCEEDED)
           - server responded but rejected -> FAILED, reason SMTP_REJECTED
           - thrown error classified NON_RETRYABLE -> FAILED immediately
           - thrown error classified UNCERTAIN -> DELIVERY_UNKNOWN, never auto-retried
           - thrown error classified RETRYABLE and attempts remain -> revert to PENDING, BullMQ
             retries with exponential backoff; attempts exhausted -> FAILED
             (`RETRIES_EXHAUSTED`)
      `onJobFailed` is a second safety net: if BullMQ itself exhausts a job's attempts, any
      recipient still PENDING/IN_PROGRESS for that job is force-reconciled to FAILED — a
      recipient can never be stranded pending just because its queue job died (Constitution
      VIII: "no recipient may disappear merely because its queue job was removed/retried").

  → StartupReconciliationService (runs once on boot)
      Finds campaigns still PREPARING or RUNNING and re-enqueues their deterministic
      preparation/maintenance jobs. Never touches terminal recipient rows. This is what makes a
      full app/Redis restart resume rather than lose or duplicate work.
```

### Non-terminal vs terminal recipient states

`RecipientStatus`: `PENDING`, `IN_PROGRESS` (both roll up into the single "pending" count) are
non-terminal; `REJECTED`, `SENT`, `FAILED`, `DELIVERY_UNKNOWN` are terminal and absorbing — nothing
in this codebase transitions a recipient out of a terminal status. `EnqueueState`
(`NOT_READY → READY_TO_QUEUE → QUEUED → PROCESSING → TERMINAL`) tracks the *queue* lifecycle
separately from the *delivery outcome* lifecycle; both are on the same `CampaignRecipient` row and
both must reach their end state before completion.

### Module map (src/)

| Module | Responsibility |
|---|---|
| `campaign/` | `CampaignService` (create/get-active), `CompletionService`, `CampaignCountersService` (recompute persisted counts from recipient rows), `status-rules.ts` (the shared invariants/predicates used across completion + progress) |
| `preparation/` | Snapshot materialization worker + `email-validator.ts` (syntax-only normalize/validate) |
| `dispatch/` | Durable, backpressured queue enqueue |
| `delivery/` | SMTP delivery worker + `outcome-classifier.ts` (maps Nodemailer errors to RETRYABLE/NON_RETRYABLE/UNCERTAIN via configurable SMTP error codes) |
| `reconciliation/` | `OrphanSweepService`, `MaintenanceProcessor`, `StartupReconciliationService` |
| `mail/` | `MailService` (pooled Nodemailer transport to Mailpit), `personalization.ts` (`{{name}}` substitution + `resolvePersonalizedName` blank/whitespace → `Customer`) |
| `recipient/` | Read-only access to the source `Recipient` dataset (keyset paging, max id) — never mutated by the app |
| `progress/` | `ProgressService.deriveCounts()` — all aggregate counts are recomputed from `CampaignRecipient` rows, never trusted from BullMQ/Bull Board |
| `queue/` | BullMQ queue registration, Redis connection factory, deterministic job-id helpers, job payload types (ids only — never bodies/snapshots) |
| `bull-board/` | Read-only queue observability UI at `/internal/queues` — explicitly *not* the system of record |
| `config/` | `loadConfig()` — single typed config object from env; every value is a conservative default, not a trusted perf value until benchmarked |

### API

`POST /api/campaigns` (201/400/409) · `GET /api/campaigns/active` (200/204) ·
`GET /api/campaigns/:id/progress` (200/404) · `GET /health`, `/ready`. Full contract:
[`specs/001-bulk-email-dryrun/contracts/openapi.yaml`](specs/001-bulk-email-dryrun/contracts/openapi.yaml).

### Container/runtime notes

- `node:22-alpine` ships `libssl.so.3` but no `openssl` CLI binary; Prisma's runtime engine
  selection shells out to `openssl version` to pick the right query engine. Without the CLI it
  mis-detects and loads a non-existent engine, crashing with an unparseable
  `Could not parse schema engine response` error. Dockerfile installs `openssl` via `apk` in both
  build and runtime stages; `prisma/schema.prisma`'s generator also pins
  `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]`. Don't remove either fix.
- `compose.yaml` has no top-level `version:` key and avoids Docker-engine-only features
  specifically so it validates under both `docker compose` and `podman compose`.
- SMTP host inside containers must be the compose service name `mailpit`, never `localhost`.
- The app retries initial DB/Redis connections with bounded backoff itself — `depends_on
  condition: service_healthy` is an optimization, not the correctness mechanism.

### Testing

Integration tests (`test/integration/`) hit real PostgreSQL/Redis/BullMQ/Nodemailer/Mailpit —
Constitution IX forbids mocking these boundaries. They cover submission/concurrency, validation,
dedupe, delivery, interruption boundaries, orphan recovery, reconciliation, and completion. Unit
tests (`test/unit/`) cover pure logic only: normalization, validation, personalization, the outcome
classifier, status transitions, reconciliation math — no infra.

### Benchmarks

Scale is validated incrementally (1k → 10k → 100k → 1M), each run recorded into a copy of
[`benchmarks/report-template.md`](benchmarks/report-template.md). A larger run must not start while
a smaller run has unresolved correctness/reconciliation/duplicate-delivery/recovery defects.

### Non-goals

No production delivery, auth, multi-tenancy, scheduling, concurrent campaigns, pause/cancel, HTML
email, deliverability/MX/DNS verification, or open/click tracking. See the constitution + spec
before proposing any of these.
