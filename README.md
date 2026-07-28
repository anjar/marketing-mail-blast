# Bulk Email Campaign Dry-Run Sender

A non-production bulk email **dry-run** application. One operator submits a single personalized email
campaign against a preloaded recipient dataset of up to 1,000,000+ records. Every recipient reaches
exactly one traceable disposition; correctness survives API / worker / Redis / PostgreSQL
interruption; nothing is ever silently double-sent.

Dry-run SMTP target is **Mailpit** — no mail leaves the machine.

## Architecture

One NestJS + TypeScript process containing the HTTP API, campaign orchestration, BullMQ producers,
delivery workers, pooled SMTP transport, PostgreSQL-derived progress, static frontend, and read-only
Bull Board. **PostgreSQL is the sole business system of record**; Redis/BullMQ hold reconstructible
operational work only.

- Spec / plan / design: [`specs/001-bulk-email-dryrun/`](specs/001-bulk-email-dryrun/)
  (`spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`, `tasks.md`)
- Constitution: [`.specify/memory/constitution.md`](.specify/memory/constitution.md)

Key invariants:
- **Single active campaign** — enforced by a PostgreSQL partial unique index (`one_active_campaign`),
  not by UI or Redis locks. Concurrent submits → one `201`, rest deterministic `409`.
- **Durable enqueue state** (`READY_TO_QUEUE → QUEUED → PROCESSING → TERMINAL`) makes queue dispatch
  reconcilable after any interruption boundary; deterministic job ids dedupe re-enqueues.
- **Conservative uncertainty** — an uncertain SMTP outcome becomes `DELIVERY_UNKNOWN`, never a false
  `SENT`/`FAILED`. Orphaned in-flight attempts (expired lease) reconcile to `DELIVERY_UNKNOWN`.
- **Reconciliation** — `total = pending + rejected + sent + failed + deliveryUnknown` always holds;
  progress derives from recipient rows, never from Bull Board.

## Quick start

```bash
cp .env.example .env
docker compose up -d          # or: podman compose up -d
# apply schema (the app container also runs this on boot)
DATABASE_URL=postgresql://mailblast:mailblast@localhost:5432/mailblast npx prisma migrate deploy
```

- App / frontend: http://localhost:3000
- Bull Board (read-only): http://localhost:3000/internal/queues
- Mailpit UI: http://localhost:8025
- Health: `/health` (liveness), `/ready` (PostgreSQL + Redis)

Seed recipients and run a campaign — see
[`specs/001-bulk-email-dryrun/quickstart.md`](specs/001-bulk-email-dryrun/quickstart.md) for the full
end-to-end validation walkthrough, and [`dummy/README.md`](dummy/README.md) for data generators.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/campaigns` | Submit one campaign (201 / 400 / 409) |
| GET | `/api/campaigns/active` | Current active campaign (200 / 204) |
| GET | `/api/campaigns/:id/progress` | PostgreSQL-derived progress (200 / 404) |
| GET | `/health`, `/ready` | Liveness / readiness |

Full contract: [`specs/001-bulk-email-dryrun/contracts/openapi.yaml`](specs/001-bulk-email-dryrun/contracts/openapi.yaml).

## Configuration

All tunables live in [`.env.example`](.env.example) with **conservative starting defaults** —
batch sizes, worker count/concurrency, backlog cap, BullMQ rate limit, retry policy, SMTP pool,
lease staleness. These are *not* trusted performance values until observed at each scale
(Constitution VI/VII). SMTP host defaults to the compose service name `mailpit`, never `localhost`
from inside a container.

## Tests

```bash
npm run test:unit          # pure logic: normalization, validation, personalization,
                           # classifier, status transitions, reconciliation

# integration needs real infra (PostgreSQL, Redis, Mailpit). Bring up the stack, then:
INTEGRATION=1 \
DATABASE_URL=postgresql://mailblast:mailblast@localhost:5432/mailblast \
REDIS_HOST=localhost SMTP_HOST=localhost \
npm run test:integration
```

Integration tests hit real PostgreSQL/Redis/BullMQ/Nodemailer/Mailpit (Constitution IX) and cover
submission, concurrency, validation, dedupe, delivery, interruption boundaries, orphan recovery,
reconciliation, and completion.

## Benchmarks

Validate scale incrementally (1k → 10k → 100k → 1M), recording the full metric set per run into a
copy of [`benchmarks/report-template.md`](benchmarks/report-template.md). A larger run must not begin
while a smaller run has unresolved correctness / reconciliation / duplicate-delivery / recovery
defects.

## Container portability

One [`compose.yaml`](compose.yaml) (Compose Specification, no engine-only features) validated with
both `docker compose config/up` and `podman compose config/up`. Provider-specific notes are inline
in the file. The app retries initial DB/Redis connections with bounded backoff, so it does not rely
on container start order alone.

## Non-goals

No production delivery, auth, multi-tenancy, scheduling, concurrent campaigns, pause/cancel, HTML
email, deliverability/MX/DNS verification, or open/click tracking. See the constitution + spec.
