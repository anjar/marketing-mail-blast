# Phase 0 Research: Bulk Email Dry-Run Sender

All decisions follow Constitution XI (Traceable Decisions): requirement, alternatives, choice,
tradeoffs, consequences, validation. No unresolved NEEDS CLARIFICATION remain; open items are
marked explicitly rather than converted into silent assumptions.

## D1. Single-active-campaign enforcement

- **Requirement**: FR-006, FR-009, FR-010; Constitution II. At most one non-terminal campaign,
  enforced atomically by the durable system of record.
- **Alternatives considered**:
  - Application-level mutex / in-memory flag — rejected: not durable, lost on restart, races.
  - Redis lock — rejected: Constitution II names Redis locks as insufficient enforcement.
  - `SELECT ... FOR UPDATE` on a singleton row — works but couples every submit to lock contention
    and needs a sentinel row.
- **Decision**: PostgreSQL **partial unique index** over active statuses:
  `CREATE UNIQUE INDEX one_active_campaign ON "Campaign" ((TRUE)) WHERE status IN ('PREPARING','RUNNING')`.
  The API does a friendly pre-check query, then relies on the insert violating the index; unique
  violation (Prisma `P2002`) is translated to a deterministic `409 Conflict`.
- **Tradeoffs**: Cannot express "one active row" as a normal column unique; uses an expression index
  on a constant predicate. Fully atomic, survives restart, requires no lock coordination.
- **Consequences**: Concurrent submits — exactly one insert wins; all losers get `409`. Committed
  migration required.
- **Validation**: Integration test firing N concurrent `POST /api/campaigns`; assert exactly one
  `201`, rest `409`; assert DB has one active row.

## D2. Campaign snapshot boundary

- **Requirement**: FR-004; records added after acceptance excluded. Must not load full dataset.
- **Alternatives**: Copy-all-on-submit (rejected: unbounded memory/latency at 1M); timestamp
  boundary (rejected: clock skew, non-unique); tag rows (rejected: mutates source dataset, forbidden).
- **Decision**: Capture `snapshotMaxRecipientId = MAX(Recipient.id)` at acceptance, stored on
  Campaign. Only `Recipient.id <= snapshotMaxRecipientId` belong. Preparation materializes
  `CampaignRecipient` rows lazily via keyset scan.
- **Tradeoffs**: Assumes monotonic recipient id (autoincrement/bigserial) — holds per spec
  "earliest stable recipient identifier" assumption. A gap/deletion below the boundary simply means
  fewer rows; still deterministic.
- **Consequences**: Snapshot is O(1) to capture; membership is a simple id predicate.
- **Validation**: Integration test inserts recipients after submit; assert excluded from campaign.

## D3. Keyset preparation scan

- **Requirement**: FR-037, FR-040; incremental, resumable, no deep OFFSET, no full load.
- **Decision**: Loop `WHERE id > :cursor AND id <= :snapshotMax ORDER BY id LIMIT :prepBatchSize`.
  Persist `preparationCursor` on Campaign **after** each batch commits. On restart, resume from the
  stored cursor.
- **Tradeoffs**: Requires stable ordering key (id) — available. No random access, but preparation is
  a forward scan so keyset is optimal.
- **Consequences**: Constant memory per batch; interruption re-processes at most one in-flight batch,
  made idempotent by unique `(campaignId, sourceRecipientId)` (insert-or-skip).
- **Validation**: Interrupt mid-prep; assert resume produces exactly one CampaignRecipient per source.

## D4. Duplicate detection within a campaign

- **Requirement**: FR-017, FR-018; earliest stable id accepted, later `DUPLICATE_EMAIL`; every
  duplicate still gets its own row.
- **Alternatives**: In-memory hash set of all normalized emails — rejected: unbounded memory at 1M.
- **Decision**: A **partial unique index** on `(campaignId, normalizedEmail)` scoped to the accepted
  set (`WHERE status NOT IN (rejected states) AND normalizedEmail IS NOT NULL`). During prep, attempt
  to claim the canonical accepted slot; on conflict, mark the row `REJECTED / DUPLICATE_EMAIL` with
  `duplicateOfId` pointing at the canonical row. Because prep scans in ascending id order, the
  earliest id wins the slot deterministically.
- **Tradeoffs**: Relies on DB uniqueness rather than app-side set — bounded memory, correct under
  concurrent prep batches (though prep is single-threaded per campaign).
- **Consequences**: Duplicate rows exist and are counted as rejected; no normalized email is
  delivered twice (SC-006).
- **Validation**: Integration test with case/whitespace-variant duplicates; assert earliest accepted,
  rest `DUPLICATE_EMAIL`, canonical name used.

## D5. Email normalization + syntax validation

- **Requirement**: FR-015, FR-016, FR-017; syntax only, no DNS/MX/network. Normalize = trim +
  lowercase.
- **Decision**: Normalize = `trim().toLowerCase()`. Missing/empty/whitespace-only -> `EMAIL_MISSING`.
  Syntax check via an explicit, unit-tested regex/validator (single `@`, non-empty local + domain,
  domain has a dot, no spaces) — deliberately conservative, documented as syntax-only. Invalid ->
  `EMAIL_INVALID_FORMAT`. No `validator.isEmail` network features used.
- **Tradeoffs**: Regex can never be RFC-perfect; acceptable — this is a dry run and the spec forbids
  claiming deliverability. Rule set is pinned by unit tests so behavior is reproducible.
- **Consequences**: Deterministic classification, no I/O in the hot validation path.
- **Validation**: Unit tests over the validation fixture matrix (missing, blank, invalid, valid).

## D6. Durable enqueue-state machine + dispatcher

- **Requirement**: FR-022a..c, FR-024, FR-038; Constitution III, V. A committed DB record must never
  depend on a single best-effort Redis enqueue.
- **Decision**: Add `enqueueState` to `CampaignRecipient`: `READY_TO_QUEUE -> QUEUED -> PROCESSING ->
  TERMINAL`. Dispatcher loop: keyset-find `READY_TO_QUEUE` rows, `addBulk()` deterministic jobs,
  then update rows to `QUEUED`. Deterministic job id `deliver:{campaignId}:{campaignRecipientId}`
  makes a repeated `addBulk` a no-op in BullMQ.
- **Interruption boundaries handled**:
  1. crash before `addBulk` — rows stay `READY_TO_QUEUE`, re-dispatched.
  2. crash after `addBulk` before DB update — job exists (deterministic id dedupes); rows still
     `READY_TO_QUEUE`, re-dispatch is a BullMQ no-op, then DB updated to `QUEUED`.
  3. crash after job starts — worker re-checks persisted status, no-ops if terminal.
  4. crash after SMTP send before terminal DB write — `IN_PROGRESS` lease expires -> reconciled to
     `DELIVERY_UNKNOWN` (never silently `SENT`/`FAILED`).
- **Tradeoffs**: Extra state column + dispatcher process vs. naive enqueue-on-accept. Required for
  interruption safety; naive path violates Constitution III/V.
- **Consequences**: Redis is fully reconstructible from `READY_TO_QUEUE`/`QUEUED` DB rows.
- **Validation**: Integration tests injecting a crash at each of the four boundaries.

## D7. Delivery worker outcome classification

- **Requirement**: FR-020..024, FR-023a/b; SENT/FAILED/DELIVERY_UNKNOWN semantics.
- **Decision**: Before send, atomic conditional update `PENDING -> IN_PROGRESS` (guarded by
  campaign + accepted + not-terminal + attempt-eligible), set `attemptStartedAt` + lease owner/expiry.
  Create `DeliveryAttempt` row, then call Nodemailer. Classify:
  - Nodemailer resolve with accepted rcpt -> `SENT`.
  - Definitive SMTP rejection (5xx / permanent) or retries exhausted -> `FAILED` + reason.
  - Transient (connection/4xx/timeout **before** acceptance) -> return to pending, BullMQ retry with
    backoff up to `maxDeliveryAttempts`.
  - Error where acceptance may already have happened (post-DATA ambiguity, socket drop after send)
    -> `DELIVERY_UNKNOWN`, no auto-retry.
  Retry-vs-terminal decided by an explicit, unit-tested error classifier mapping Nodemailer error
  `code`/`responseCode` to `{ retryable | non_retryable | uncertain }`.
- **Tradeoffs**: Classifier must be conservative — when in doubt, `DELIVERY_UNKNOWN` (never a false
  `SENT`). Some genuinely-delivered messages may be recorded unknown; acceptable per FR-023.
- **Consequences**: One recipient's failure never blocks others (per-job isolation).
- **Validation**: Unit tests for the classifier; integration tests for definitive-fail,
  transient-retry, uncertain, and terminal-recipient duplicate job no-op.

## D8. IN_PROGRESS lease / orphan recovery

- **Requirement**: FR-022b/c, FR-038; distinguish live worker from orphaned in-flight attempt.
- **Decision**: `leaseOwner` + `leaseExpiresAt` on `CampaignRecipient`; worker renews via heartbeat
  while the attempt runs. Reconciliation treats only `IN_PROGRESS` rows with `leaseExpiresAt < now()`
  (past configurable staleness) as orphaned -> `DELIVERY_UNKNOWN`. Live-lease rows untouched.
- **Tradeoffs**: Staleness timeout must exceed max realistic SMTP round-trip + heartbeat interval to
  avoid falsely orphaning a live attempt. Documented conservative default; tuned by benchmark.
- **Consequences**: No second concurrent attempt on a leased recipient; orphans resolve safely.
- **Validation**: Kill worker mid-send; assert row becomes `DELIVERY_UNKNOWN` after staleness, not
  resent; assert a live-lease row is left alone.

## D9. Backpressure

- **Requirement**: Constitution VI; do not enqueue all 1M into Redis unbounded.
- **Decision**: Dispatcher checks BullMQ counts (waiting+active+delayed+prioritized) before each
  `addBulk`; pause when `>= maxBufferedQueueJobs`, resume below threshold. Undispatched work stays as
  `READY_TO_QUEUE` rows in PostgreSQL.
- **Tradeoffs**: Dispatcher polls queue depth; small overhead vs. unbounded Redis growth.
- **Consequences**: Redis footprint bounded regardless of campaign size.
- **Validation**: 100k+ run; assert queue depth stays under configured cap.

## D10. Completion + reconciliation

- **Requirement**: FR-030..033, SC-003/004; Constitution I, V.
- **Decision**: Completion checker (job + startup + post-batch trigger) uses an **atomic conditional
  update**: `RUNNING -> COMPLETED / COMPLETED_WITH_ISSUES` only when
  `pending = 0 AND in_progress = 0 AND no READY_TO_QUEUE/QUEUED/PROCESSING remain AND counters
  reconcile` (`total = pending + rejected + sent + failed + deliveryUnknown`). Counters maintained
  incrementally but a reconciliation query recomputes from `CampaignRecipient` and blocks completion
  on mismatch (treated as a correctness defect, logged).
- **Tradeoffs**: Recompute cost at completion vs. trusting counters — recompute is bounded per
  campaign and required by FR-033.
- **Consequences**: Only one worker can flip the status (conditional update); no inconsistent
  completion.
- **Validation**: Integration counter-reconciliation + completion tests; deliberately skew a counter
  and assert completion refused.

## D11. Queue topology + job types

- **Requirement**: separate logical job types; identifiers-only payloads.
- **Decision**: Queues: `preparation` (one job/campaign, resumable), `delivery` (one job/recipient),
  `maintenance` (reconciliation/completion/lease-sweep, repeatable). Payloads carry ids only
  (`campaignId`, `campaignRecipientId`) — never bodies/snapshots. Deterministic delivery job id.
  `removeOnComplete`/`removeOnFail` bounded by age+count; removal never erases DB outcomes.
- **Validation**: Assert payload size is id-only; assert removed jobs don't lose recipient state.

## D12. SMTP transport (Nodemailer + Mailpit)

- **Requirement**: pooled transport per worker; env-configured; default target `mailpit:1025`.
- **Decision**: One `nodemailer.createTransport({ pool: true, ... })` per worker process, closed on
  `onModuleDestroy` / shutdown hook. Host defaults to Compose service name `mailpit` (never
  `localhost` from inside a container), all params env-driven. Worker concurrency coordinated with
  `SMTP_MAX_CONNECTIONS` so jobs don't just pile into Nodemailer's internal queue.
- **Tradeoffs**: Pool cap becomes the real throughput ceiling; documented, tuned by benchmark.
- **Validation**: Small correctness run verifies message content/personalization via Mailpit API.

## D13. Frontend

- **Requirement**: static page, no framework/build/polling/SSE.
- **Decision**: `public/index.html` + `app.js` + `styles.css` served by `@nestjs/serve-static`. On
  load, `GET /api/campaigns/active`; if active, hide/disable form + show banner + render persisted
  progress; Refresh re-fetches progress. Frontend never enforces the single-active invariant.
- **Validation**: Manual + a light integration check that active-state hides the form.

## D14. One process vs. split API/worker

- **Requirement**: Constitution X (minimum scope) vs. plan's "separate only when justified".
- **Decision**: Single service running API + dispatcher + workers, with explicit BullMQ `Worker`
  lifecycle and graceful shutdown (drain in-flight, close pool, close Redis/DB). Split deferred.
- **Tradeoffs**: Shared process couples API latency with worker CPU; acceptable at this scope and
  reversible (workers already isolated in `delivery/`). Revisit if a benchmark shows API starvation.
- **Validation**: Benchmarks record CPU/mem; split reconsidered only on observed contention.

## D15. Compose portability (Docker + Podman)

- **Requirement**: one `compose.yaml` valid under both providers.
- **Decision**: Compose Specification only (no `version:` key, no Docker-engine-only features).
  Named volumes for Postgres/Redis/Mailpit persistence. Healthchecks for all four services. App
  retries initial DB/Redis connect with bounded backoff (don't trust `depends_on` alone). Validate
  with `docker compose config/up` and `podman compose config/up`; document any provider gap inline
  rather than forking the file.
- **Open item (explicit)**: Podman `compose` may delegate to `docker-compose` or `podman-compose`
  depending on host; healthcheck/`condition: service_healthy` support differs. Documented as a
  known validation risk, resolved during Compose validation, not assumed away.
- **Validation**: Run all four commands in quickstart; record differences in compose comments.

## D16. Dummy data generators

- **Requirement**: `/dummy` SQL using `generate_series()`, no committed data, no Node memory.
- **Decision**: Parameterized SQL (`psql -v scale=...`) generating throughput (valid unique) and
  validation (invalid/missing/blank/duplicate) profiles server-side. Scripts: clear, seed-scale,
  seed-validation, verify-counts, verify-fixtures. Throughput dataset excludes malformed rows unless
  the test measures validation.
- **Validation**: verify-count scripts assert exact row + duplicate/invalid counts per profile.

## Open items summary

- **O1 (D15)**: Podman Compose healthcheck / `service_healthy` parity — resolve during validation.
- All config defaults (batch sizes, concurrency, backlog cap, rate limit, retries, backoff, SMTP
  pool, lease staleness) are **conservative starting values**, explicitly *not* trusted until
  observed at each scale (Constitution VI/VII). Recorded in `.env.example` + benchmark reports.
