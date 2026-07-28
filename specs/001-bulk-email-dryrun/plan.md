# Implementation Plan: Bulk Email Campaign Dry-Run Sender

**Branch**: `001-bulk-email-dryrun` | **Date**: 2026-07-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-bulk-email-dryrun/spec.md`

## Summary

One operator submits a single personalized email campaign (subject + plain-text body) against a
preloaded recipient dataset of up to 1,000,000+ records. The system fixes a stable snapshot,
validates and de-duplicates recipients incrementally, dispatches bounded delivery work through a
durable queue to a dry-run SMTP target (Mailpit), and tracks every recipient to exactly one
terminal outcome (`SENT` / `FAILED` / `DELIVERY_UNKNOWN`) with counts reconcilable from PostgreSQL
at all times. Correctness survives API / worker / Redis / PostgreSQL interruption without resending
`SENT` recipients or silently converting uncertain deliveries.

Technical approach: one NestJS + TypeScript codebase (API + orchestrator + workers in one process
for minimum scope), PostgreSQL as the sole business system of record via Prisma, BullMQ + Redis as
reconstructible operational work, Nodemailer pooled SMTP per worker, Bull Board read-only queue
observability, and a static HTML/CSS/vanilla-JS page served by Nest. PostgreSQL enforces the
single-active-campaign invariant with a partial unique index; a durable enqueue-state machine on
each `CampaignRecipient` makes queue dispatch reconciliable after any interruption boundary. One
`compose.yaml` runs on both Docker Compose and Podman Compose.

## Technical Context

**Language/Version**: Node.js 22 LTS with TypeScript 5.x

**Primary Dependencies**: NestJS 10, Prisma 5 (ORM + migrations), BullMQ 5 (+ ioredis),
`@bull-board/nestjs` + `@bull-board/api` (read-only), Nodemailer 6 (pooled SMTP),
`@nestjs/serve-static` (static frontend). Validation via `class-validator` for DTOs; email-syntax
validation via an explicit internal validator (documented in research).

**Storage**: PostgreSQL 16 (business system of record). Redis 7 (operational queue state only).

**Testing**: Jest (unit); Jest + Testcontainers-style real infra (integration) exercising real
PostgreSQL, Redis, BullMQ, Nodemailer, and Mailpit. No mocked external boundaries in integration.

**Target Platform**: Linux containers via Compose Specification (`compose.yaml`), validated on both
Docker Compose and Podman Compose.

**Project Type**: Web service (single backend serving a static frontend + background workers in one
process).

**Performance Goals**: None asserted. Throughput and duration are measured, not guaranteed
(FR-042). Incremental validation at 1k / 10k / 100k / 1M recipients; conservative documented
default config values, trusted only after observation at each scale.

**Constraints**: Never load the full recipient / message / job set into memory (FR-037, FR-040).
Keyset pagination only; no deep `OFFSET`. Bounded `addBulk()` enqueue with a configurable backlog
cap. One long-lived pooled SMTP transport per worker, coordinated with worker concurrency.

**Scale/Scope**: 1,000,000+ recipient snapshot per campaign; at most one active campaign globally;
single operator; dry-run only (no production delivery, auth, scheduling, or deliverability checks).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] I. Recipient Outcome Integrity — every `CampaignRecipient` reaches one disposition
      (rejected-with-reason, or `SENT`/`FAILED`/`DELIVERY_UNKNOWN`). `SENT` only on confirmed SMTP
      acceptance; uncertain outcomes resolve to `DELIVERY_UNKNOWN`, never silently `SENT`/`FAILED`.
      Terminal states are absorbing (no transition out).
- [x] II. Single Active Campaign — enforced by a PostgreSQL **partial unique index** over active
      statuses (`PREPARING`, `RUNNING`); API translates the unique violation to `409 Conflict`. UI
      disabling and pre-check queries are convenience only, not the enforcement.
- [x] III. Interruption-Safe and Idempotent Processing — bounded delivery jobs with deterministic
      IDs derived from `(campaignId, campaignRecipientId)`; unique `(campaignId, sourceRecipientId)`;
      worker re-checks persisted status and no-ops on terminal; lease/heartbeat on `IN_PROGRESS`;
      startup reconciliation restores prep/dispatch/completion.
- [x] IV. Validate Before Queueing — preparation persists REJECTED (`EMAIL_MISSING`,
      `EMAIL_INVALID_FORMAT`, `DUPLICATE_EMAIL`) before any delivery job is created; only
      `READY_TO_QUEUE` accepted recipients are dispatched.
- [x] V. Durable State and Reconciliation — all aggregates reproducible from `CampaignRecipient`
      rows; incremental counters are an optimization with a reconciliation service verifying
      `total = pending + rejected + sent + failed + deliveryUnknown`. Bull Board never a data source.
- [x] VI. Bounded Work and Controlled Concurrency — keyset-paginated prep + dispatch, bounded
      `addBulk()`, configurable backlog cap with pause/resume, configurable batch/worker/concurrency/
      rate-limit/retry/SMTP-pool values with conservative documented defaults.
- [x] VII. Measured Performance — benchmark harness records the full mandated metric set per scale;
      larger scale only after smaller passes clean (SC-010..SC-012).
- [x] VIII. Observable Failures — persisted state + structured logs keyed by campaign / recipient /
      job / attempt IDs; Bull Board exposes waiting/active/delayed/retried/completed/failed; no
      recipient lost to job removal (durable `CampaignRecipient` is authoritative).
- [x] IX. Realistic and Failure-Oriented Testing — integration tests hit real DB/Redis/BullMQ/
      Nodemailer/Mailpit and cover all four interruption boundaries, reconciliation, duplicate job
      execution, retries/exhaustion, and recovery.
- [x] X. Minimum Sufficient Scope — one process (API + workers) unless a benchmark justifies split;
      no speculative production features; framework capabilities used directly.
- [x] XI. Traceable Decisions — research.md records each non-trivial decision (requirement,
      alternatives, choice, tradeoffs, consequences, validation).
- [x] Non-Goals respected — no auth, multi-tenancy, scheduling, concurrent campaigns, production
      delivery, deliverability verification, analytics, or pause/cancel introduced.

**Result**: PASS. No violations; Complexity Tracking empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-bulk-email-dryrun/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (OpenAPI + job contracts)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── main.ts                       # Nest bootstrap, graceful shutdown hooks, startup reconciliation
├── app.module.ts
├── config/                       # typed env config + conservative documented defaults
├── prisma/                       # PrismaService, module
├── campaign/                     # CampaignModule: submission, status transitions, completion
├── recipient/                    # RecipientModule: read-only access to source dataset
├── preparation/                  # CampaignPreparationModule: keyset snapshot scan, validate, dedupe
├── dispatch/                     # DispatchModule: READY_TO_QUEUE -> addBulk, backpressure
├── delivery/                     # DeliveryModule: BullMQ delivery worker, outcome classification
├── queue/                        # QueueModule: BullMQ queues, deterministic job IDs, connection
├── mail/                         # MailModule: pooled Nodemailer transport, personalization
├── progress/                     # ProgressModule: PostgreSQL-derived progress + reconciliation
├── reconciliation/              # startup + periodic reconciliation of prep/dispatch/completion/leases
├── health/                       # HealthModule: /health, /ready (DB + Redis)
└── bull-board/                   # BullBoardModule: read-only, mounted at /internal/queues

prisma/
├── schema.prisma
└── migrations/                   # includes partial unique index for single active campaign

public/                          # static frontend served by Nest
├── index.html
├── app.js
└── styles.css

dummy/                           # SQL generators (generate_series), not committed data
├── 00_clear.sql
├── 10_seed_throughput.sql        # parameterized scale via psql -v
├── 20_seed_validation.sql
├── 30_verify_counts.sql
└── README.md

test/
├── unit/                         # normalization, validation, placeholder, classification, transitions, reconciliation
└── integration/                  # real DB/Redis/BullMQ/Nodemailer/Mailpit; interruption boundaries

benchmarks/
└── report-template.md            # mandated metric set per scale run

compose.yaml                     # postgres, redis, mailpit, app (Docker + Podman compatible)
.env.example
```

**Structure Decision**: Single NestJS project (web service). API, orchestration, dispatcher, and
BullMQ workers run in **one process/service** for minimum sufficient scope (Constitution X), with
explicit graceful-shutdown and lifecycle hooks. A split into a separate worker service is deferred
until a benchmark demonstrates the need (documented in research.md as the reversible decision).
Campaign orchestration (`campaign/`), delivery (`delivery/`), and progress-query (`progress/`)
responsibilities are kept in separate modules per the required separation.

## Complexity Tracking

> No constitution violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
