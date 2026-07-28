---
description: "Task list for Bulk Email Campaign Dry-Run Sender"
---

# Tasks: Bulk Email Campaign Dry-Run Sender

**Input**: Design documents from `/specs/001-bulk-email-dryrun/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (openapi.yaml, queue-jobs.md), quickstart.md

**Tests**: INCLUDED — Constitution IX (Realistic and Failure-Oriented Testing) and every user story's
Independent Test criterion mandate automated unit + integration coverage against real
PostgreSQL/Redis/BullMQ/Nodemailer/Mailpit.

**Organization**: Grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Parallelizable (different files, no incomplete-task dependency)
- **[Story]**: US1..US5 (user story phases only)

## Path Conventions

Single NestJS project. `src/` modules, `prisma/`, `public/`, `dummy/`, `test/`, `benchmarks/`,
`compose.yaml` at repo root (per plan.md Structure Decision).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project skeleton, tooling, local orchestration.

- [ ] T001 Initialize NestJS + TypeScript project at repo root (package.json, tsconfig.json, nest-cli.json, src/main.ts, src/app.module.ts)
- [ ] T002 Add dependencies: @nestjs/{common,core,config,platform-express,serve-static}, prisma, @prisma/client, bullmq, ioredis, @bull-board/api, @bull-board/nestjs, nodemailer; dev: jest, ts-jest, @types/*, eslint, prettier
- [ ] T003 [P] Configure ESLint + Prettier + tsconfig strict in .eslintrc.cjs, .prettierrc, tsconfig.json
- [ ] T004 [P] Configure Jest with unit + integration projects in jest.config.ts (test/unit, test/integration)
- [ ] T005 [P] Author compose.yaml with postgres, redis, mailpit, app services; named volumes; healthchecks for all four; Compose Specification only (no version key, no Docker-engine-only features)
- [ ] T006 [P] Author .env.example with all configurable values and conservative documented defaults (prep batch size, enqueue batch size, maxBufferedQueueJobs, worker count, worker concurrency, BullMQ rate limit, maxDeliveryAttempts, retry backoff, SMTP host=mailpit/port=1025/secure/pool/maxConnections/maxMessages/timeouts, lease staleness)
- [ ] T007 [P] Author /dummy SQL generators using generate_series: dummy/00_clear.sql, dummy/10_seed_throughput.sql (parameterized scale), dummy/20_seed_validation.sql, dummy/30_verify_counts.sql, dummy/README.md

**Checkpoint**: `docker compose config` and `podman compose config` parse; project builds.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, persistence, queue/mail infrastructure, health, static serving, resilience.
**⚠️ No user-story work begins until this phase completes.**

- [ ] T008 Author prisma/schema.prisma: Recipient, Campaign, CampaignRecipient, DeliveryAttempt models + all enums (CampaignStatus, RecipientStatus, EnqueueState, RejectionReason, DeliveryFailureReason, AttemptStatus) per data-model.md
- [ ] T009 Create Prisma migration adding tables, the partial unique index `one_active_campaign` (single active), unique `(campaignId, sourceRecipientId)`, partial unique `(campaignId, normalizedEmail)` over accepted rows, and dispatch/progress/lease indexes in prisma/migrations/
- [ ] T010 [P] Implement PrismaService with bounded-backoff initial connect + onModuleDestroy disconnect in src/prisma/prisma.service.ts and src/prisma/prisma.module.ts
- [ ] T011 [P] Implement typed config module loading + validating env defaults in src/config/config.module.ts and src/config/app-config.ts
- [ ] T012 Implement QueueModule: BullMQ connection (ioredis) with bounded-backoff, register `preparation`/`delivery`/`maintenance` queues, deterministic job-id helpers in src/queue/
- [ ] T013 [P] Implement MailModule: one pooled Nodemailer transport per worker from env, closed on shutdown, in src/mail/mail.module.ts and src/mail/mail.service.ts
- [ ] T014 [P] Implement HealthModule: GET /health (liveness) and GET /ready (PostgreSQL + Redis reachable → 200/503) in src/health/
- [ ] T015 [P] Configure static frontend serving from public/ via @nestjs/serve-static in src/app.module.ts
- [ ] T016 [P] Implement read-only BullBoardModule mounted at /internal/queues in src/bull-board/bull-board.module.ts
- [ ] T017 [P] Configure structured logging (campaign/recipient/job/attempt id fields) and global exception filter mapping domain errors in src/common/
- [ ] T018 Wire graceful shutdown in src/main.ts: enableShutdownHooks, drain BullMQ workers, close SMTP pool, Redis, Prisma; invoke startup reconciliation entrypoint (implemented in US4)

**Checkpoint**: App boots, `/ready` green, migrations applied, Bull Board reachable, queues connected.

---

## Phase 3: User Story 1 - Submit a Campaign (Priority: P1) 🎯 MVP

**Goal**: Operator submits subject + body; exactly one campaign is created against a fixed snapshot, preparation begins, concurrent/duplicate submits get deterministic 409.

**Independent Test**: Submit valid subject/body with no active campaign → one campaign, snapshot fixed, prep starts; second submit while active → 409; N concurrent submits → exactly one 201.

### Tests for User Story 1

- [ ] T019 [P] [US1] Unit test: subject/body non-whitespace validation in test/unit/create-campaign.dto.spec.ts
- [ ] T020 [P] [US1] Integration test: single submit creates one campaign + snapshot + PREPARING, second submit → 409, in test/integration/campaign-submit.spec.ts
- [ ] T021 [P] [US1] Integration test: N concurrent POST /api/campaigns → exactly one 201, rest 409 (DB partial unique index) in test/integration/campaign-concurrent.spec.ts

### Implementation for User Story 1

- [ ] T022 [P] [US1] CreateCampaignRequest DTO with class-validator non-whitespace subject/body in src/campaign/dto/create-campaign.dto.ts
- [ ] T023 [US1] CampaignService.create: capture snapshotMaxRecipientId = MAX(Recipient.id), insert Campaign(PREPARING), translate Prisma P2002 → CampaignActiveError, in src/campaign/campaign.service.ts
- [ ] T024 [US1] CampaignController: POST /api/campaigns (201/400/409) and GET /api/campaigns/active (200/204) in src/campaign/campaign.controller.ts, CampaignModule in src/campaign/campaign.module.ts
- [ ] T025 [US1] Map CampaignActiveError → 409 `{error:"CAMPAIGN_ACTIVE"}` via exception filter in src/common/
- [ ] T026 [US1] Enqueue deterministic `prepare:{campaignId}` job on accepted submit in src/campaign/campaign.service.ts
- [ ] T027 [P] [US1] RecipientModule read-only source access (MAX id, keyset page query) in src/recipient/recipient.service.ts and recipient.module.ts
- [ ] T028 [US1] CampaignPreparation worker skeleton: keyset scan id>cursor and id<=snapshotMax, materialize CampaignRecipient rows (copy snapshot email+name), persist preparationCursor per batch, transition PREPARING→RUNNING at end, in src/preparation/preparation.processor.ts and preparation.module.ts
- [ ] T029 [P] [US1] Minimal frontend: subject input, body textarea, Send button, GET /api/campaigns/active on load to hide/disable form + show banner, in public/index.html, public/app.js, public/styles.css

**Checkpoint**: One campaign submittable; snapshot fixed; prep materializes recipients; single-active enforced by DB.

---

## Phase 4: User Story 2 - Personalize and Validate Recipients (Priority: P1)

**Goal**: Accepted recipients receive correctly personalized dry-run mail; invalid + duplicate records rejected with recorded reason, never entering delivery.

**Independent Test**: Run over dataset with valid/missing-name/invalid-email/duplicate records → each disposition + message matches FR-011..018; rejected produce no Mailpit message.

### Tests for User Story 2

- [ ] T030 [P] [US2] Unit test: email normalize (trim+lowercase) + syntax validation matrix in test/unit/email-validation.spec.ts
- [ ] T031 [P] [US2] Unit test: {{name}} replacement + Customer fallback (missing/blank/multi-occurrence/no-placeholder) in test/unit/personalization.spec.ts
- [ ] T032 [P] [US2] Unit test: outcome classifier (retryable/non-retryable/uncertain) in test/unit/outcome-classifier.spec.ts
- [ ] T033 [P] [US2] Integration test: duplicate normalized emails → earliest id accepted, rest DUPLICATE_EMAIL with duplicateOfId in test/integration/duplicate-detection.spec.ts
- [ ] T034 [P] [US2] Integration test: missing → EMAIL_MISSING, invalid → EMAIL_INVALID_FORMAT, none queued in test/integration/invalid-rejection.spec.ts
- [ ] T035 [P] [US2] Integration test: successful SMTP delivery → SENT, personalization verified via Mailpit API in test/integration/delivery-success.spec.ts
- [ ] T036 [P] [US2] Integration test: definitive SMTP failure → FAILED; retryable pre-acceptance failure retries then FAILED on exhaustion in test/integration/delivery-failure.spec.ts

### Implementation for User Story 2

- [ ] T037 [P] [US2] Email normalize + syntax validator util in src/preparation/email-validator.ts
- [ ] T038 [P] [US2] Personalization util ({{name}} → name or Customer) in src/mail/personalization.ts
- [ ] T039 [P] [US2] SMTP error → outcome classifier ({retryable|non_retryable|uncertain}) in src/delivery/outcome-classifier.ts
- [ ] T040 [US2] Extend preparation: trim/normalize/validate → REJECTED(EMAIL_MISSING/EMAIL_INVALID_FORMAT); claim canonical `(campaignId, normalizedEmail)`, loser → REJECTED(DUPLICATE_EMAIL)+duplicateOfId; accepted → enqueueState READY_TO_QUEUE; increment counters, in src/preparation/preparation.processor.ts
- [ ] T041 [US2] Dispatcher: keyset-find READY_TO_QUEUE, bounded addBulk deterministic `deliver:{campaignId}:{campaignRecipientId}` jobs, set QUEUED, pause when backlog ≥ maxBufferedQueueJobs, in src/dispatch/dispatch.service.ts and dispatch.module.ts
- [ ] T042 [US2] Delivery worker: precondition guard (belongs/accepted/not-terminal/eligible) with terminal→no-op, create DeliveryAttempt before send, MailService.send personalized body, classify → SENT/FAILED/DELIVERY_UNKNOWN, update counters, in src/delivery/delivery.processor.ts and delivery.module.ts
- [ ] T043 [US2] Configure delivery queue attempts=maxDeliveryAttempts + exponential backoff; on BullMQ exhaustion reconcile recipient → terminal FAILED (not left pending), in src/delivery/

**Checkpoint**: End-to-end dry-run send works; validation + dedupe + personalization correct; outcomes recorded.

---

## Phase 5: User Story 3 - View Campaign Progress (Priority: P2)

**Goal**: Refresh returns latest persisted progress: status, reason-grouped counts, timestamps, reconciling to total.

**Independent Test**: Drive recipients to various dispositions, GET progress → all counts PostgreSQL-derived and total = pending+rejected+sent+failed+deliveryUnknown; browser reload keeps progress reachable.

### Tests for User Story 3

- [ ] T044 [P] [US3] Unit test: reconciliation `total = pending+rejected+sent+failed+deliveryUnknown` in test/unit/reconciliation.spec.ts
- [ ] T045 [P] [US3] Integration test: progress reason-grouped counts + reconciliation over mixed dataset in test/integration/progress.spec.ts

### Implementation for User Story 3

- [ ] T046 [P] [US3] ProgressService: derive counts from CampaignRecipient, rejectedByReason + failedByReason groupings, reconciliation query, in src/progress/progress.service.ts
- [ ] T047 [US3] GET /api/campaigns/:id/progress (200 CampaignProgress / 404) in src/progress/progress.controller.ts and progress.module.ts
- [ ] T048 [US3] Frontend progress summary + rejected/failed-by-reason breakdown + Refresh button rendering persisted state in public/index.html, public/app.js

**Checkpoint**: Progress queryable during and after processing; counts reconcile.

---

## Phase 6: User Story 4 - Recover an Interrupted Campaign (Priority: P1)

**Goal**: Interrupted campaign resumes safely — no resend of terminal recipients, uncertain deliveries → DELIVERY_UNKNOWN, pending work continues, counts reconcilable, no full-dataset load.

**Independent Test**: Force restart at each interruption boundary → SENT not resent, orphaned in-flight → DELIVERY_UNKNOWN (not retried/marked), pending resumes, same active campaign identifiable.

### Tests for User Story 4

- [ ] T049 [P] [US4] Unit test: status-transition rules (terminal absorbing, IN_PROGRESS guards, completion gate) in test/unit/status-transitions.spec.ts
- [ ] T050 [P] [US4] Integration test: crash before enqueue and after enqueue-before-DB-update → converges, no duplicate delivery, in test/integration/interrupt-dispatch.spec.ts
- [ ] T051 [P] [US4] Integration test: terminal recipient re-run of delivery job → successful no-op, no second SMTP, in test/integration/terminal-noop.spec.ts
- [ ] T052 [P] [US4] Integration test: worker killed after SMTP before terminal write → expired lease → DELIVERY_UNKNOWN, in test/integration/orphan-recovery.spec.ts
- [ ] T053 [P] [US4] Integration test: Redis restart + queue reconstruction from READY_TO_QUEUE/QUEUED rows in test/integration/redis-restart.spec.ts

### Implementation for User Story 4

- [ ] T054 [US4] IN_PROGRESS lease: atomic PENDING→IN_PROGRESS with leaseOwner/leaseExpiresAt/attemptStartedAt + heartbeat renewal during send, in src/delivery/delivery.processor.ts
- [ ] T055 [US4] Maintenance: orphan sweep — expired-lease IN_PROGRESS → DELIVERY_UNKNOWN (live lease untouched) in src/reconciliation/orphan-sweep.service.ts
- [ ] T056 [US4] Startup reconciliation: detect active campaign, restore missing preparation (resume cursor), re-dispatch READY_TO_QUEUE, re-schedule maintenance, in src/reconciliation/startup-reconciliation.service.ts (wired from T018)
- [ ] T057 [US4] Maintenance queue processor (repeatable + startup) driving dispatch/orphan-sweep/completion checks with bounded age/count job removal in src/reconciliation/maintenance.processor.ts

**Checkpoint**: All four interruption boundaries safe; no resend; no silent SENT/FAILED; counts reconcile.

---

## Phase 7: User Story 5 - Finish and Start Another Campaign (Priority: P2)

**Goal**: On terminal status the form re-enables, a new campaign is accepted, and the finished campaign's progress stays queryable.

**Independent Test**: Drive campaign to terminal → form re-enables, new valid campaign accepted, prior progress still queryable.

### Tests for User Story 5

- [ ] T058 [P] [US5] Integration test: completion → COMPLETED vs COMPLETED_WITH_ISSUES; refused when counters don't reconcile; new campaign accepted after; prior progress queryable, in test/integration/completion.spec.ts

### Implementation for User Story 5

- [ ] T059 [US5] Completion checker: atomic conditional RUNNING→COMPLETED/COMPLETED_WITH_ISSUES only when pending=0, no READY_TO_QUEUE/QUEUED/PROCESSING remain, counters reconcile; set completedAt; in src/campaign/completion.service.ts
- [ ] T060 [US5] Frontend: on terminal status re-enable subject/body/Send, clear active banner, keep progress visible in public/app.js

**Checkpoint**: Serial campaign loop closes; completion gated on reconciliation.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T061 [P] Author dummy verify-fixtures script (duplicate + invalid counts) dummy/40_verify_fixtures.sql
- [ ] T062 [P] Author benchmark report template with full mandated metric set in benchmarks/report-template.md
- [ ] T063 [P] Document Mailpit config (SMTP/web port, retention limit, storage path/volume) in compose.yaml + README
- [ ] T064 Validate compose portability: docker compose config/up and podman compose config/up; document any provider gap inline in compose.yaml (research D15 O1)
- [ ] T065 [P] Run incremental scale validation 1k→10k→100k→1M, recording metrics per benchmarks/report-template.md (larger only after smaller passes clean)
- [ ] T066 [P] Update repo README + quickstart cross-links; document all config defaults as starting values

---

## Dependencies & Execution Order

- **Setup (P1)** → **Foundational (P2)** block everything.
- **US1 (P3)** MVP — depends only on Foundational.
- **US2 (P4)** depends on US1 (campaign + preparation skeleton + recipients).
- **US3 (P5)** depends on US2 (dispositions exist to report). Can start after US2 counters land.
- **US4 (P6)** depends on US2 delivery pipeline (adds lease/recovery around it).
- **US5 (P7)** depends on US2 (+ US4 recovery for reconcile-safe completion).
- **Polish (P8)** after correctness stories; T065 scale runs last.

## Parallel Opportunities

- Setup: T003, T004, T005, T006, T007 in parallel.
- Foundational: T010, T011, T013, T014, T015, T016, T017 in parallel (after T008/T009 schema; T012 before queue-dependent).
- Each story's test tasks ([P]) run in parallel before/alongside implementation.
- US1 impl: T022, T027, T029 parallel; T023 before T024/T026.
- US2 utils T037/T038/T039 parallel before processors T040/T041/T042.

## Implementation Strategy

- **MVP = Phase 1 + Phase 2 + US1**: submit one campaign, fix snapshot, single-active enforced, preparation materializes recipients.
- **Correctness-complete = + US2 + US4**: the P1 dry-run correctness + interruption-safety core.
- **Operator loop = + US3 + US5**: progress visibility and serial campaigns.
- **Trusted at scale = + Polish T064/T065**: portability + incremental benchmark validation.
