# Quickstart & Validation Guide: Bulk Email Dry-Run Sender

Runnable scenarios that prove the feature end-to-end. Details live in [data-model.md](./data-model.md),
[contracts/openapi.yaml](./contracts/openapi.yaml), and [contracts/queue-jobs.md](./contracts/queue-jobs.md).
Config defaults are conservative **starting** values (Constitution VI/VII) — not trusted until observed.

## Prerequisites

- Docker Compose **or** Podman Compose.
- `psql` client (for `/dummy` seeding and count verification).
- Ports free: Postgres 5432, Redis 6379, Mailpit SMTP 1025 + web/API 8025, app 3000.

## 1. Bring up the stack

```bash
cp .env.example .env
docker compose config        # validate (also: podman compose config)
docker compose up -d          # also validated with: podman compose up -d
```

Services: `postgres`, `redis`, `mailpit`, `app` (API + dispatcher + workers, one process). App
retries initial DB/Redis connect with bounded backoff; healthchecks gate readiness.

**Expected**: `GET http://localhost:3000/ready` → `200`; Mailpit UI at `http://localhost:8025`;
Bull Board (read-only) at `http://localhost:3000/internal/queues`.

## 2. Seed recipients (`/dummy`, server-side generate_series)

```bash
# throughput profile (valid, unique) at a chosen scale
psql "$DATABASE_URL" -v scale=1000 -f dummy/10_seed_throughput.sql
psql "$DATABASE_URL" -f dummy/30_verify_counts.sql          # asserts row count
# validation profile (invalid/missing/blank/duplicate) for correctness runs
psql "$DATABASE_URL" -f dummy/20_seed_validation.sql
```

**Expected**: verify scripts report exact expected row / duplicate / invalid counts. No generated
data is committed; nothing passes through Node memory.

## 3. Submit a campaign (Story 1, FR-001..010)

```bash
curl -sX POST localhost:3000/api/campaigns \
  -H 'content-type: application/json' \
  -d '{"subject":"Hello","body":"Hi {{name}}, welcome."}'
```

**Expected**: `201` + `CampaignSummary` (status `PREPARING`). A second submit while active → `409`
`{ "error": "CAMPAIGN_ACTIVE" }`. Whitespace-only subject/body → `400`.

Concurrent check:
```bash
for i in $(seq 1 20); do curl -sX POST localhost:3000/api/campaigns \
  -H 'content-type: application/json' -d '{"subject":"x","body":"y"}' -o /dev/null -w "%{http_code}\n" & done; wait
```
**Expected**: exactly one `201`, rest `409` (DB partial unique index, D1).

## 4. Watch progress (Story 3, FR-025..029)

```bash
ID=<campaign id from step 3>
curl -s localhost:3000/api/campaigns/active
curl -s localhost:3000/api/campaigns/$ID/progress | jq
```

**Expected**: `CampaignProgress` where `total = pending + rejected + sent + failed +
deliveryUnknown` at all times; `rejectedByReason` / `failedByReason` grouped counts present. All
values are PostgreSQL-derived (never Bull Board).

## 5. Personalization + validation (Story 2)

Run against the validation profile, then inspect via Mailpit API for a small run:
```bash
curl -s localhost:8025/api/v1/messages | jq '.messages[].Snippet'
```

**Expected**: `{{name}}` → recipient name, or `Customer` when name missing/blank (FR-011/012);
missing email → `EMAIL_MISSING`, invalid → `EMAIL_INVALID_FORMAT`, duplicate normalized → earliest
id `SENT`-eligible and later ones `DUPLICATE_EMAIL` (FR-016..018); rejected recipients produced no
Mailpit message.

## 6. Interruption & recovery (Story 4, FR-035..038)

For each boundary, restart the app mid-processing (`docker compose restart app`) and re-check
progress:
- before enqueue → work re-dispatched from `READY_TO_QUEUE`.
- after enqueue before DB update → deterministic job id no-ops; state converges.
- after job start → worker re-checks status, terminal → no-op (no resend).
- after SMTP before terminal write → expired `IN_PROGRESS` lease → `DELIVERY_UNKNOWN` (not `SENT`/
  `FAILED`, not retried).

**Expected**: `SENT` recipients never resent; counts stay reconcilable; same active campaign
identifiable; no full-dataset load.

## 7. Completion (Story 5, FR-030..034)

**Expected**: campaign flips to `COMPLETED` (no rejected/failed/unknown) or
`COMPLETED_WITH_ISSUES`, only when `pending = 0`, no undispatched/queued/processing work remains,
and counters reconcile. Form re-enables; prior campaign progress stays queryable.

## 8. Automated tests

```bash
npm run test:unit          # normalization, validation, placeholder, classification, transitions, reconciliation
npm run test:integration   # real Postgres/Redis/BullMQ/Nodemailer/Mailpit; all 4 interruption boundaries
```

## 9. Scale benchmarks (Constitution VII, SC-010..012)

Run in order — a larger scale starts only after the smaller passes with no correctness /
reconciliation / duplicate-send / recovery defect:

```bash
psql "$DATABASE_URL" -v scale=1000    -f dummy/10_seed_throughput.sql   # then 10k, 100k, 1M
# run campaign, record metrics into benchmarks/report-template.md
```

Each run records the full mandated metric set (recipient/valid/invalid/duplicate counts, subject &
body size, prep/enqueue batch sizes, backlog cap, worker count/concurrency, SMTP max connections,
rate-limit + retry settings, resource limits, duration, prep + delivery throughput, outcome counts,
duplicate-send count, delivery-unknown count, CPU/mem/disk/PostgreSQL/Redis observations, plus
Mailpit retention + storage settings). Large-scale numbers reflect the whole local pipeline
including Mailpit ingestion — **not** production email throughput.

## Compose portability check

```bash
docker compose config && podman compose config
docker compose up -d && podman compose up -d
```
Document any provider-specific difference inline in `compose.yaml` comments rather than forking the
file (see research D15 open item on Podman healthcheck parity).
