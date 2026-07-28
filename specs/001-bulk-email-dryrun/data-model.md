# Phase 1 Data Model: Bulk Email Dry-Run Sender

PostgreSQL is the sole business system of record. All aggregates are reproducible from
`CampaignRecipient` rows (Constitution V). Prisma models below; enums and constraints are the
authoritative contract.

## Enums

```text
CampaignStatus        = PREPARING | RUNNING | COMPLETED | COMPLETED_WITH_ISSUES | FAILED
RecipientStatus       = PENDING | IN_PROGRESS | REJECTED | SENT | FAILED | DELIVERY_UNKNOWN
EnqueueState          = NOT_READY | READY_TO_QUEUE | QUEUED | PROCESSING | TERMINAL
RejectionReason       = EMAIL_MISSING | EMAIL_INVALID_FORMAT | DUPLICATE_EMAIL
DeliveryFailureReason = SMTP_REJECTED | SMTP_TIMEOUT | CONNECTION_ERROR | RETRIES_EXHAUSTED | OTHER
AttemptStatus         = STARTED | SUCCEEDED | FAILED | UNKNOWN
```

- `CampaignStatus.FAILED` is the optional unrecoverable-orchestration status only; it never replaces
  recipient-level outcomes (per plan input). Active statuses = `PREPARING`, `RUNNING`.
- `RecipientStatus`: `PENDING` + `IN_PROGRESS` roll up into the single "pending" progress count
  (FR-022). `SENT` / `FAILED` / `DELIVERY_UNKNOWN` are terminal + absorbing (FR-021).
- `EnqueueState` tracks durable dispatch independently of `RecipientStatus` (D6).

## Recipient (reusable source dataset)

| Field | Type | Notes |
|-------|------|-------|
| id | BigInt PK (bigserial) | stable ascending identifier; snapshot + dedupe ordering key |
| email | String? | may be missing/invalid; validated per campaign, not here |
| name | String? | nullable |
| createdAt | DateTime | |
| updatedAt | DateTime | |

- Seeded out of band (`/dummy`). **Not** modified through the application in this phase.

## Campaign (one submitted blast)

| Field | Type | Notes |
|-------|------|-------|
| id | UUID PK | |
| subject | String | non-whitespace required (validated at submit) |
| body | String (text) | plain text; may contain `{{name}}` |
| status | CampaignStatus | default `PREPARING` |
| snapshotMaxRecipientId | BigInt | stable snapshot upper bound (D2) |
| preparationCursor | BigInt | last prepared recipient id; default 0 |
| totalCount | Int | snapshot recipient count (set as prep completes / precomputed) |
| pendingCount | Int | PENDING + IN_PROGRESS rollup |
| rejectedCount | Int | |
| sentCount | Int | |
| failedCount | Int | |
| deliveryUnknownCount | Int | |
| totalDeliveryAttemptCount | Int | sum of DeliveryAttempt rows |
| startedAt | DateTime | acceptance time |
| completedAt | DateTime? | set on terminal status |
| createdAt / updatedAt | DateTime | |

**Constraints**
- Partial unique index (single active campaign, D1):
  `CREATE UNIQUE INDEX one_active_campaign ON "Campaign"((true)) WHERE status IN ('PREPARING','RUNNING');`
- Counters are an optimization; reconciliation recomputes from `CampaignRecipient` (D10).
- Invariant (checked, not DB-enforced): `totalCount = pendingCount + rejectedCount + sentCount +
  failedCount + deliveryUnknownCount`.

**Status transitions**
```text
PREPARING --(prep done)--> RUNNING
RUNNING   --(all terminal, counters reconcile, no issues)--> COMPLETED
RUNNING   --(all terminal, counters reconcile, >=1 rejected/failed/unknown)--> COMPLETED_WITH_ISSUES
(any active) --(unrecoverable orchestration error)--> FAILED   [optional, rare]
```
All transitions are atomic conditional updates (guarded WHERE clause) so only one worker flips.

## CampaignRecipient (durable per-campaign snapshot + processing record)

| Field | Type | Notes |
|-------|------|-------|
| id | BigInt PK | |
| campaignId | UUID FK -> Campaign | |
| sourceRecipientId | BigInt FK -> Recipient | |
| snapshotEmail | String? | copied from source at prep (independence from source changes) |
| normalizedEmail | String? | trim+lowercase; null when unusable |
| snapshotName | String? | copied from source |
| personalizedName | String | resolved name or `Customer` fallback (FR-011/012) |
| status | RecipientStatus | default `PENDING` for accepted; `REJECTED` for invalid/dupe |
| rejectionReason | RejectionReason? | set iff status REJECTED |
| deliveryFailureReason | DeliveryFailureReason? | set iff status FAILED |
| duplicateOfId | BigInt? FK -> CampaignRecipient | canonical row for DUPLICATE_EMAIL |
| deliveryAttemptCount | Int | default 0 |
| enqueueState | EnqueueState | default `NOT_READY` |
| leaseOwner | String? | worker id holding IN_PROGRESS lease (D8) |
| leaseExpiresAt | DateTime? | orphan detection threshold |
| attemptStartedAt | DateTime? | set on PENDING->IN_PROGRESS |
| terminalAt | DateTime? | set when a terminal status recorded |
| createdAt / updatedAt | DateTime | |

**Constraints**
- Unique `(campaignId, sourceRecipientId)` — one row per source recipient; makes prep idempotent.
- Partial unique `(campaignId, normalizedEmail)` **over accepted rows only**:
  `WHERE normalizedEmail IS NOT NULL AND status NOT IN ('REJECTED')` — canonical accepted email is
  unique per campaign; losing insert -> `REJECTED / DUPLICATE_EMAIL` with `duplicateOfId` (D4).
- Index `(campaignId, enqueueState, id)` for keyset dispatch scans.
- Index `(campaignId, status)` for progress aggregation.
- Index `(status, leaseExpiresAt)` for orphan/lease sweeps.

**Per-recipient state machine**
```text
                     ┌─ REJECTED (EMAIL_MISSING | EMAIL_INVALID_FORMAT | DUPLICATE_EMAIL)  [terminal]
prep classifies ─────┤
                     └─ accepted: enqueueState NOT_READY->READY_TO_QUEUE
PENDING --(dispatch)--> (enqueueState QUEUED) --(worker claim, lease)--> IN_PROGRESS
IN_PROGRESS --(SMTP accepted)--------------------> SENT              [terminal]
IN_PROGRESS --(definitive fail / retries exhausted)--> FAILED       [terminal]
IN_PROGRESS --(uncertain / orphaned lease)------> DELIVERY_UNKNOWN  [terminal]
IN_PROGRESS --(transient, attempts remain)------> PENDING (retry, backoff)
terminal --> enqueueState TERMINAL
```
Terminal states are absorbing: no transition out (FR-021, FR-024).

## DeliveryAttempt (audit history)

| Field | Type | Notes |
|-------|------|-------|
| id | BigInt PK | |
| campaignRecipientId | BigInt FK -> CampaignRecipient | |
| attemptNumber | Int | 1-based |
| jobId | String | deterministic `deliver:{campaignId}:{campaignRecipientId}` |
| status | AttemptStatus | STARTED -> SUCCEEDED/FAILED/UNKNOWN |
| smtpResponse | String? | normalized SMTP response or error info |
| acceptanceDefinitive | Boolean | true only when acceptance/rejection is certain |
| startedAt | DateTime | before SMTP call |
| finishedAt | DateTime? | |
| createdAt | DateTime | |

- Created **before** SMTP communication (D7). Audit only; the current outcome lives on
  `CampaignRecipient`. Contributes to `totalDeliveryAttemptCount`.
- `acceptanceDefinitive = false` maps an outcome toward `DELIVERY_UNKNOWN`, never silent `SENT`.

## Reconciliation queries (derived, authoritative)

Reproducible from `CampaignRecipient` (Constitution V), used to verify counters + gate completion:
```text
pending          = count(status IN ('PENDING','IN_PROGRESS'))
rejected         = count(status = 'REJECTED')
sent             = count(status = 'SENT')
failed           = count(status = 'FAILED')
deliveryUnknown  = count(status = 'DELIVERY_UNKNOWN')
total            = count(*)                                  -- within campaign snapshot
assert total = pending + rejected + sent + failed + deliveryUnknown   -- FR-029, SC-004
```
Completion permitted only when `pending = 0` AND no `enqueueState IN (READY_TO_QUEUE,QUEUED,
PROCESSING)` remains AND the assertion holds (D10).
