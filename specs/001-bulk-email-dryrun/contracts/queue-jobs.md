# Queue Job Contracts (BullMQ)

Redis/BullMQ hold **reconstructible operational work only**; PostgreSQL is authoritative. Payloads
carry identifiers only — never message bodies, recipient snapshots, or batches of objects.

## Queue: `preparation`

- **Purpose**: keyset-scan the campaign snapshot, materialize `CampaignRecipient` rows, validate,
  dedupe, mark accepted `READY_TO_QUEUE`. Resumable from `Campaign.preparationCursor`.
- **Job id**: `prepare_{campaignId}` (deterministic; one prep job per campaign).
- **Payload**:
  ```json
  { "campaignId": "uuid" }
  ```
- **Idempotency**: unique `(campaignId, sourceRecipientId)` + persisted cursor make re-runs safe.
- **Completion**: transitions campaign `PREPARING -> RUNNING` when cursor reaches
  `snapshotMaxRecipientId`.

## Queue: `delivery`

- **Purpose**: process exactly one `CampaignRecipient`: claim lease, `PENDING -> IN_PROGRESS`,
  create `DeliveryAttempt`, SMTP send, classify outcome.
- **Job id**: `deliver_{campaignId}_{campaignRecipientId}` (deterministic — dedupes re-enqueue).
- **Payload**:
  ```json
  { "campaignId": "uuid", "campaignRecipientId": 12345 }
  ```
- **Options**: `attempts = maxDeliveryAttempts`, `backoff = { type: 'exponential', delay: retryBackoffMs }`,
  bounded `removeOnComplete` / `removeOnFail` (age + count). Removal never erases DB outcomes.
- **Worker preconditions (atomic)**: recipient belongs to campaign AND accepted AND not terminal AND
  attempt-eligible; terminal recipient -> **successful no-op** (no SMTP).
- **Retry semantics**: only pre-acceptance transient errors retry; definitive errors -> `FAILED`
  immediately; uncertain acceptance -> `DELIVERY_UNKNOWN` (no auto-retry). On BullMQ attempt
  exhaustion, persisted state is reconciled to terminal `FAILED` (never left pending).

## Queue: `maintenance`

- **Purpose**: repeatable reconciliation — dispatch `READY_TO_QUEUE` (bounded `addBulk`,
  backpressure), sweep expired `IN_PROGRESS` leases -> `DELIVERY_UNKNOWN`, evaluate completion,
  verify counter reconciliation, restore missing prep/dispatch on startup.
- **Job id**: `maintenance_{campaignId}` (repeatable) + `startup-reconcile` on boot.
- **Payload**:
  ```json
  { "campaignId": "uuid" }
  ```
- **Backpressure**: pause `addBulk` when waiting+active+delayed+prioritized `>= maxBufferedQueueJobs`.

## Global rules

- Deterministic job ids are an optimization against duplicate queue entries, **not** the final
  idempotency guarantee — persisted `CampaignRecipient` status is.
- Interruption boundaries (crash before enqueue / after enqueue before DB update / after job start /
  after SMTP before terminal write) all resolve safely — see research D6/D7/D8.
- Bull Board mounts these queues **read-only** at `/internal/queues` for observability only.
