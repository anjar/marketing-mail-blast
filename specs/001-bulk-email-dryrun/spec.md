# Feature Specification: Bulk Email Campaign Dry-Run Sender

**Feature Branch**: `001-bulk-email-dryrun`

**Created**: 2026-07-28

**Status**: Draft

**Input**: User description: "Build a non-production bulk email campaign dry-run application that allows an operator to submit one personalized email campaign to a preloaded recipient dataset containing up to 1,000,000 or more records."

## Clarifications

### Session 2026-07-28

- Q: How is an in-flight send attempt (started but not yet acknowledged) represented durably, so recovery can distinguish it from a never-attempted recipient? → A: Add a durable non-terminal `IN_PROGRESS` state, persisted before the send call and carrying an attempt start time; both `IN_PROGRESS` and `PENDING` roll up into the "pending" progress count.
- Q: When does a failed send attempt retry vs. become terminal `FAILED`? → A: Transient errors retry up to a configurable maximum; on exhaustion the recipient becomes terminal `FAILED`. Non-retryable errors become terminal `FAILED` immediately. A recipient between retries returns to a non-terminal (pending) state.
- Q: How does recovery decide an `IN_PROGRESS` recipient is orphaned (interrupted) vs. still being actively worked by a live worker? → A: A worker holds a renewable lease/heartbeat on the `IN_PROGRESS` record; only records with an expired lease (configurable staleness timeout) are treated as orphaned and reconciled to `DELIVERY_UNKNOWN`. A record with a live lease is left alone.
- Q: Once a recipient is `DELIVERY_UNKNOWN`, can any process move it out of that state in this phase? → A: No. `DELIVERY_UNKNOWN` is strictly terminal and absorbing; no automatic or manual transition out of it in this phase, by any process.
- Q: Can a campaign reach a terminal status while any recipient is still `IN_PROGRESS`? → A: No. Completion requires zero `PENDING` and zero `IN_PROGRESS` (both count as pending); no terminal campaign status while any send attempt is in flight.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Submit a Campaign (Priority: P1)

An operator enters an email subject and plain-text body, presses Send, and the system creates
exactly one campaign that targets a fixed snapshot of the preloaded recipient dataset and begins
processing it.

**Why this priority**: This is the entry point of the entire feature. Without campaign submission
and the single-active-campaign guarantee, no other behavior can occur. It is the minimum viable
slice: an operator can start one campaign against the preloaded dataset.

**Independent Test**: Submit a valid subject and body against a preloaded dataset with no active
campaign; verify exactly one campaign is created, a snapshot is fixed, processing begins, and a
second submission while active is rejected with a deterministic conflict response.

**Acceptance Scenarios**:

1. **Given** no campaign is active, **When** the operator submits a non-empty subject and body,
   **Then** one campaign is accepted, a recipient snapshot is fixed, and processing begins without
   a second confirmation step.
2. **Given** the subject or body contains only whitespace, **When** the operator submits the form,
   **Then** no campaign is created and validation errors are shown.
3. **Given** a campaign is active, **When** another campaign request is submitted (including via a
   second browser tab or a direct call to the campaign creation interface), **Then** the request is
   rejected with a deterministic conflict response and no second campaign is created.
4. **Given** two valid campaign submissions arrive concurrently, **When** they are processed,
   **Then** exactly one campaign is created and every other request receives a deterministic
   conflict response.
5. **Given** the operator double-clicks Send or a request is retried, **When** the duplicate arrives,
   **Then** no second active campaign results.

---

### User Story 2 - Personalize and Validate Recipients (Priority: P1)

Each accepted recipient receives a correctly personalized dry-run message, while invalid and
duplicate recipient records are explicitly rejected with a recorded reason and never enter the
delivery pipeline.

**Why this priority**: Correctness of per-recipient handling is the core value of the dry run.
Personalization, syntax validation, and duplicate suppression are what the run exists to verify.

**Independent Test**: Run a campaign over a dataset containing valid names, missing names, invalid
emails, and duplicate normalized emails; verify each recipient's message and disposition match the
rules below.

**Acceptance Scenarios**:

1. **Given** a recipient named `Alicia` and a body containing `{{name}}`, **When** the message is
   generated, **Then** every occurrence of `{{name}}` is replaced with `Alicia`.
2. **Given** a recipient with an empty, missing, or whitespace-only name and a body containing
   `{{name}}`, **When** the message is generated, **Then** every occurrence of `{{name}}` is
   replaced with `Customer`.
3. **Given** the body contains no `{{name}}` placeholder, **When** the message is generated,
   **Then** the recipient name does not affect the body.
4. **Given** a recipient email that is missing/empty/whitespace-only, **When** the recipient is
   validated, **Then** it is rejected with reason `EMAIL_MISSING` and no delivery attempt is created.
5. **Given** a recipient email that is syntactically invalid, **When** the recipient is validated,
   **Then** it is rejected with reason `EMAIL_INVALID_FORMAT` and no delivery attempt is created.
6. **Given** multiple recipient records share the same normalized email (trimmed, lowercased),
   **When** the campaign is processed, **Then** only the record with the earliest stable recipient
   identifier is accepted and each later record is rejected with reason `DUPLICATE_EMAIL`; the
   accepted record supplies the name used for personalization.

---

### User Story 3 - View Campaign Progress (Priority: P2)

The operator can press Refresh at any time during or after processing to see the latest persisted
campaign progress, including status, outcome counts broken down by reason, and timestamps.

**Why this priority**: Observability of the run is required to interpret correctness and throughput
results, but the campaign can process correctly without it, so it ranks below submission and
per-recipient correctness.

**Independent Test**: Start a campaign, let some recipients reach various dispositions, press
Refresh, and verify all displayed counts come from persisted data and reconcile with the total;
reload the browser and verify progress is still reachable.

**Acceptance Scenarios**:

1. **Given** a campaign is active, **When** the operator clicks Refresh, **Then** the latest
   persisted counts and status are displayed.
2. **Given** delivery failures have occurred, **When** progress is refreshed, **Then** failed counts
   are shown broken down by delivery failure reason.
3. **Given** recipient validation failures have occurred, **When** progress is refreshed, **Then**
   rejected counts are shown broken down by rejection reason.
4. **Given** the browser is reloaded, **When** the page opens again, **Then** the current active
   campaign and its latest progress remain visible.
5. **Given** progress is displayed, **Then** `total recipients = pending + rejected + sent + failed +
   delivery unknown` holds exactly.

---

### User Story 4 - Recover an Interrupted Campaign (Priority: P1)

An interrupted campaign continues safely after the application restarts, without resending
recipients whose outcomes are already terminal and without silently converting uncertain deliveries.

**Why this priority**: Interruption safety is a non-negotiable correctness property for a run of
this scale; a restart that duplicates sends or corrupts outcomes invalidates the whole exercise.
It is P1 because it protects the guarantees established by Stories 1 and 2.

**Independent Test**: Start a campaign, force a restart mid-processing, and verify terminal outcomes
are preserved, `SENT`/`FAILED`/`DELIVERY_UNKNOWN` recipients are not reprocessed, pending work
resumes, and counts remain reconcilable — all without loading the full dataset into memory.

**Acceptance Scenarios**:

1. **Given** some recipients are marked `SENT`, **When** the application is restarted, **Then**
   those recipients are not sent again.
2. **Given** some recipients are pending, **When** the application is restarted, **Then** their work
   continues without resetting completed outcomes.
3. **Given** the same unit of work executes more than once, **When** a terminal outcome already
   exists for a recipient, **Then** no new intended delivery is made for that recipient.
4. **Given** delivery acceptance became uncertain during interruption, **When** recovery occurs,
   **Then** the recipient is recorded as `DELIVERY_UNKNOWN` rather than being silently marked `SENT`
   or `FAILED` or automatically retried.
5. **Given** any restart, **When** recovery runs, **Then** the same active campaign remains
   identifiable and campaign counts remain reconcilable.

---

### User Story 5 - Finish and Start Another Campaign (Priority: P2)

After the active campaign reaches a terminal status, the form becomes available again and the
operator can submit a new campaign; the finished campaign's final progress remains queryable.

**Why this priority**: Serial campaign flow completes the operator loop but depends on all prior
stories; it is valuable but not part of the first correctness-proving slice.

**Independent Test**: Drive a campaign to a terminal status, verify the form re-enables and a new
valid campaign is accepted, and confirm the prior campaign's final progress is still queryable.

**Acceptance Scenarios**:

1. **Given** no recipients remain pending and all totals reconcile, **When** completion is
   evaluated, **Then** the campaign enters `COMPLETED` if no recipient was rejected, failed, or ended
   unknown, otherwise `COMPLETED_WITH_ISSUES`.
2. **Given** the campaign reaches a terminal status, **Then** the subject field, body field, and Send
   button become available.
3. **Given** a previous campaign is complete, **When** a new valid campaign is submitted, **Then**
   the new campaign is accepted.
4. **Given** a campaign still has at least one pending recipient, **Then** the form remains
   unavailable.

---

### Edge Cases

- Subject or body is empty after trimming whitespace → campaign rejected, validation error shown.
- `{{name}}` appears multiple times in the body → every occurrence is replaced.
- Recipient name is whitespace-only → treated as missing; `{{name}}` becomes `Customer`.
- Recipient email has surrounding whitespace → trimmed before validation and normalization.
- Two records with the same email differing only in case/whitespace → normalized equal; earliest
  identifier accepted, rest `DUPLICATE_EMAIL`.
- Recipients added to the dataset after submission acceptance → excluded from the running campaign.
- Application restarts while a recipient's SMTP acknowledgement is in flight → recorded as
  `DELIVERY_UNKNOWN`, not retried, not marked sent or failed.
- Concurrent or double-clicked submissions → exactly one campaign; all others get conflict responses.
- Dataset of 1,000,000+ records → processed incrementally without holding the full recipient set,
  personalized-message set, or delivery-job set in memory simultaneously.
- Completion evaluated when aggregate counts do not reconcile with recipient records → campaign MUST
  NOT be reported complete.

## Requirements *(mandatory)*

### Functional Requirements

**Campaign form & submission**

- **FR-001**: The application MUST present one campaign form with a required subject field, a
  required plain-text body field, and a Send button, with no authentication, login, account, or
  role requirement.
- **FR-002**: The subject and body MUST each contain at least one non-whitespace character;
  otherwise the submission MUST be rejected with validation errors and no campaign created.
- **FR-003**: A valid submission MUST start processing immediately without a second confirmation step.
- **FR-004**: On accepted submission the system MUST create one campaign targeting a fixed snapshot
  of the recipient records present at acceptance time; records added later MUST be excluded.
- **FR-005**: The recipient list MUST NOT be entered or uploaded through the form; recipients come
  from a separately preloaded test dataset.

**Single active campaign**

- **FR-006**: At most one campaign MAY be in a non-terminal state at any time, enforced atomically
  by the durable system of record.
- **FR-007**: While a campaign is active, the subject field, body field, and Send button MUST be
  disabled or hidden, and the page MUST display a visible banner stating a mail blast is processing.
- **FR-008**: While a campaign is active, additional campaign creation requests MUST be rejected —
  including from another browser tab or a direct call to the creation interface.
- **FR-009**: When multiple valid campaign requests arrive concurrently, exactly one MUST create a
  campaign; every other MUST receive a deterministic conflict response identifying that another
  campaign is active.
- **FR-010**: Submitting the same request twice (double-click or retry) MUST NOT create two active
  campaigns.

**Personalization**

- **FR-011**: Where the body contains the exact placeholder `{{name}}`, every occurrence MUST be
  replaced with the recipient's name when that name has at least one non-whitespace character.
- **FR-012**: When the recipient name is empty, missing, or whitespace-only, every `{{name}}`
  occurrence MUST be replaced with `Customer`.
- **FR-013**: When the body contains no `{{name}}`, the recipient name MUST NOT affect the body.
- **FR-014**: No template variables or template features other than `{{name}}` are supported; the
  subject MUST NOT be personalized.

**Recipient validation & duplicates**

- **FR-015**: Each recipient email MUST be validated for syntax only, after trimming leading and
  trailing whitespace, before that recipient is submitted for delivery; the system MUST NOT claim an
  address exists, accepts mail, or has valid MX/DNS records.
- **FR-016**: Recipients with missing/empty/whitespace-only emails MUST be rejected with reason
  `EMAIL_MISSING`; syntactically invalid emails MUST be rejected with reason `EMAIL_INVALID_FORMAT`.
  Rejected recipients MUST NOT enter the delivery pipeline.
- **FR-017**: Within one campaign, emails MUST be compared after trimming and lowercasing; no
  normalized address may be intentionally submitted for delivery more than once.
- **FR-018**: When records share a normalized email, the record with the earliest stable recipient
  identifier MUST be accepted and later matching records rejected with reason `DUPLICATE_EMAIL`; the
  accepted record supplies the personalization name.
- **FR-019**: Every rejected recipient MUST carry an explicit rejection reason.

**Recipient outcomes**

- **FR-020**: Every recipient in the snapshot MUST eventually have exactly one disposition: rejected
  before delivery, or accepted and reaching exactly one terminal outcome.
- **FR-021**: Permitted terminal delivery outcomes are `SENT` (dry-run target positively confirmed
  acceptance), `FAILED` (delivery definitively failed with a recorded reason), and
  `DELIVERY_UNKNOWN` (acceptance cannot be determined). All three are strictly terminal and
  absorbing: once recorded, no automatic or manual process transitions a recipient out of a terminal
  outcome in this phase.
- **FR-022**: A recipient still waiting, queued, processing, or awaiting retry MUST remain
  non-terminal and be counted as pending. Non-terminal recipients occupy exactly one of two durable
  states: `PENDING` (accepted, no send attempt yet started) or `IN_PROGRESS` (a send attempt has
  started but no terminal outcome is yet recorded). Both `PENDING` and `IN_PROGRESS` roll up into
  the single "pending" count in progress reporting.
- **FR-022a**: Before invoking the dry-run send for an accepted recipient, the system MUST durably
  transition that recipient from `PENDING` to `IN_PROGRESS` and record an attempt start time. The
  send MUST NOT be invoked while the recipient is still recorded as `PENDING`.
- **FR-022b**: A worker MUST claim an `IN_PROGRESS` recipient with a renewable ownership lease
  (heartbeat) that it renews while the attempt is live. Recovery MUST treat as orphaned only those
  `IN_PROGRESS` records whose lease has expired past a configurable staleness timeout; an
  `IN_PROGRESS` record with a live lease MUST be left untouched (preventing a second concurrent
  attempt, per FR-038).
- **FR-022c**: An orphaned `IN_PROGRESS` recipient is the interrupted-during-send case: the system
  MUST reconcile it and, when dry-run acceptance cannot be positively confirmed, resolve it to
  `DELIVERY_UNKNOWN` (per FR-023). It MUST NOT be silently marked `SENT` or `FAILED` and MUST NOT be
  automatically re-sent. A recipient found in `PENDING` on restart has no started attempt and MAY be
  attempted fresh.
- **FR-023**: The system MUST NOT report `SENT` without evidence of dry-run acceptance, MUST NOT
  report `FAILED` when delivery may have been accepted, and MUST NEVER silently convert an uncertain
  delivery into `SENT` or `FAILED`.
- **FR-023a**: A send attempt that fails with a transient error MUST be retried up to a configurable
  maximum attempt count; between retries the recipient MUST return to a non-terminal state and remain
  in the pending count. On exhausting the maximum, the recipient MUST become terminal `FAILED` with
  the recorded failure reason.
- **FR-023b**: A send attempt that fails with a non-retryable error MUST become terminal `FAILED`
  immediately, without further retry. Distinguishing transient from non-retryable errors, and the
  maximum attempt count and backoff, MUST be configurable.
- **FR-024**: A recipient marked `SENT`, `FAILED`, or `DELIVERY_UNKNOWN` MUST NOT be automatically
  submitted again after an application restart.

**Progress reporting**

- **FR-025**: The operator MUST be able to request current campaign progress while processing is
  underway, via a Refresh button that returns the latest persisted progress; automatic polling, SSE,
  WebSockets, and push are not required.
- **FR-026**: Reloading the browser page MUST NOT lose access to the active campaign's progress.
- **FR-027**: Progress MUST show campaign status; total snapshot recipients; pending; rejected;
  sent; failed; unknown-delivery; total delivery attempts; campaign start time; and completion time
  when complete.
- **FR-028**: Rejected recipients MUST be broken down by rejection reason and failed recipients by
  delivery failure reason.
- **FR-029**: At all times `total recipients = pending + rejected + sent + failed + delivery unknown`
  MUST hold, with counts derived from persisted campaign data, not browser-local state or
  queue-observability tooling.

**Completion**

- **FR-030**: A campaign remains active while at least one snapshot recipient is non-terminal, i.e.
  in `PENDING` or `IN_PROGRESS`. A campaign MUST NOT reach a terminal status while any recipient is
  still `IN_PROGRESS`.
- **FR-031**: A campaign reaches `COMPLETED` when no recipients remain pending, all accepted
  recipients are terminal, and none ended `FAILED` or `DELIVERY_UNKNOWN`.
- **FR-032**: A campaign reaches `COMPLETED_WITH_ISSUES` when no recipients remain pending and at
  least one recipient was rejected, failed, or ended with unknown delivery.
- **FR-033**: A campaign MUST NOT be reported complete if its aggregate counts do not reconcile with
  its recipient records.
- **FR-034**: On terminal status the form MUST become available again, a new campaign MAY be
  submitted, and the previous campaign's final progress MUST remain queryable.

**Interruption & recovery**

- **FR-035**: After restart the same active campaign MUST remain identifiable, persisted terminal
  outcomes MUST remain unchanged, and campaign counts MUST remain reconcilable.
- **FR-036**: After restart, `SENT` recipients MUST NOT be resent, and `FAILED` and
  `DELIVERY_UNKNOWN` recipients MUST NOT be automatically retried; non-terminal work MAY continue or
  be reconstructed.
- **FR-037**: Recovery MUST NOT require the entire recipient dataset to be loaded into memory.
- **FR-038**: Duplicate execution of the same unit of work MUST NOT intentionally produce a second
  delivery for a recipient that already has a terminal outcome.
- **FR-039**: Manual campaign pause, cancellation, deletion, and restart-from-beginning are out of
  scope for this phase.

**Large dataset behavior**

- **FR-040**: The application MUST support datasets of at least 1,000,000 recipient records without
  holding the complete recipient list, complete personalized-message set, or complete delivery-job
  set in memory simultaneously.
- **FR-041**: Processing MAY be incremental but the operator MUST experience it as one campaign;
  submission and progress queries MUST remain usable while processing is underway.
- **FR-042**: No fixed completion-time guarantee is established; throughput and duration MUST be
  measured and reported rather than assumed.

### Key Entities *(include if feature involves data)*

- **Campaign**: One dry-run blast. Attributes: subject, plain-text body, status (active vs.
  `COMPLETED` / `COMPLETED_WITH_ISSUES`), start time, completion time, and a fixed reference to its
  recipient snapshot. At most one non-terminal Campaign exists at a time.
- **Recipient Record (dataset)**: A preloaded record with a stable identifier, a name (possibly
  missing/whitespace), and an email (possibly missing/invalid). Source of truth for the snapshot;
  not editable through the application.
- **Campaign Recipient (snapshot member)**: A recipient's participation in one campaign, with a
  normalized email, a disposition (rejected with a rejection reason, or accepted). An accepted
  recipient is in exactly one state: a non-terminal state — `PENDING` (no attempt started) or
  `IN_PROGRESS` (attempt started, with an attempt start time, no terminal outcome yet) — or exactly
  one terminal outcome (`SENT` / `FAILED` / `DELIVERY_UNKNOWN`). Unique per campaign-recipient
  combination.
- **Delivery Attempt**: A recorded attempt to deliver to an accepted recipient, contributing to the
  total delivery-attempts count and carrying a failure reason when applicable.
- **Rejection Reason**: Enumerated cause a recipient was rejected — at minimum `EMAIL_MISSING`,
  `EMAIL_INVALID_FORMAT`, `DUPLICATE_EMAIL`.
- **Delivery Failure Reason**: Recorded cause of a `FAILED` outcome, used for the failed-by-reason
  breakdown.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A campaign of 1,000,000 recipient records is processed without loading the complete
  recipient set into application memory at once.
- **SC-002**: Every recipient in the snapshot is represented in exactly one current disposition count.
- **SC-003**: When a campaign completes, zero recipients remain pending.
- **SC-004**: Campaign-level totals exactly reconcile with recipient-level records at all times
  (`total = pending + rejected + sent + failed + delivery unknown`).
- **SC-005**: Invalid email addresses never produce delivery attempts.
- **SC-006**: No normalized email address is intentionally delivered more than once within one
  campaign.
- **SC-007**: Restart tests preserve terminal outcomes and do not resend recipients already marked
  `SENT`.
- **SC-008**: Progress remains queryable throughout campaign processing and after completion.
- **SC-009**: Concurrent submissions never create more than one active campaign.
- **SC-010**: Validation runs are performed incrementally at 1,000, 10,000, 100,000, and 1,000,000
  recipients.
- **SC-011**: Each scale run records total duration, throughput, outcome counts, duplicate count,
  unknown-delivery count, and observed resource consumption.
- **SC-012**: A full-scale (1,000,000) run is attempted only after all smaller validation runs
  complete without unresolved correctness defects.

## Assumptions

- Recipients are preloaded into a test dataset out of band; loading that dataset is not part of this
  feature's user-facing flow.
- The dry-run email target is a non-production SMTP-style test target that can positively confirm,
  reject, or leave acceptance uncertain; it is not a production email service.
- "Earliest stable recipient identifier" is a deterministic, persisted ordering already present on
  recipient records (e.g., insertion order), used to pick the accepted record among duplicates.
- Email syntax validation uses a standard format check only; no network lookup of any kind is
  performed.
- A single operator uses the application; the single-active-campaign rule is a global invariant, not
  per-user.
- "Recipient added after acceptance" refers to dataset growth; the running campaign is bound to its
  snapshot regardless.

## Explicit Non-Goals

This feature does not include: production email delivery; production email service-provider
integration; authentication or authorization; recipient entry or CSV upload through the campaign
page; editing the recipient dataset through the application; HTML or rich-text email editing;
subject personalization; template variables other than `{{name}}`; automatic progress updates;
campaign scheduling; concurrent campaigns; campaign pause or cancellation; manual retry of terminal
recipients; A/B testing; open or click tracking; bounce or complaint handling; unsubscribe
management; DNS, MX, mailbox-existence, or deliverability verification; production deployment
requirements.
