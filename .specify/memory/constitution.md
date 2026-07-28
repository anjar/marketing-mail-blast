<!--
Sync Impact Report
Version change: TEMPLATE → 1.0.0
Modified principles: n/a (initial ratification; template placeholders filled)
Added sections:
  - I. Recipient Outcome Integrity
  - II. Single Active Campaign
  - III. Interruption-Safe and Idempotent Processing
  - IV. Validate Before Queueing
  - V. Durable State and Reconciliation
  - VI. Bounded Work and Controlled Concurrency
  - VII. Measured Performance
  - VIII. Observable Failures
  - IX. Realistic and Failure-Oriented Testing
  - X. Minimum Sufficient Scope
  - XI. Traceable Decisions
  - Non-Goals
  - Governance
Removed sections: none (template had none filled)
Templates requiring updates:
  - .specify/templates/plan-template.md ✅ updated (Constitution Check gate list added)
  - .specify/templates/spec-template.md ✅ reviewed, no change required (scope-neutral)
  - .specify/templates/tasks-template.md ✅ reviewed, no change required (phase-neutral)
  - .claude/skills/speckit-*/SKILL.md ✅ reviewed, generic, no agent-specific refs found
Follow-up TODOs: none
-->

# Bulk Email Dry-Run Sender Constitution

## Core Principles

### I. Recipient Outcome Integrity

Every submitted recipient MUST have an explicit and traceable disposition.

A recipient MUST either:

1. be rejected during ingestion with a recorded validation reason; or
2. be accepted into the campaign and eventually reach exactly one terminal delivery outcome.

Permitted terminal delivery outcomes are:

- `SENT`: SMTP acceptance was positively confirmed.
- `FAILED`: delivery definitively failed, with a recorded reason.
- `DELIVERY_UNKNOWN`: the system cannot determine whether the SMTP target accepted the
  message, such as after an interruption during the final delivery acknowledgement.

The system MUST NOT report `SENT` without evidence of SMTP acceptance.

The system MUST NOT report `FAILED` when delivery may have been accepted.

A campaign MUST NOT be marked successfully completed while accepted recipients remain in
non-terminal states.

Campaign-level totals MUST reconcile exactly with recipient-level records.

### II. Single Active Campaign

At most one campaign MAY be in a non-terminal state at any time.

This invariant MUST be enforced atomically by the durable system of record. Frontend button
disabling, in-memory flags, queue inspection, or Redis locks alone are insufficient enforcement.

Concurrent campaign creation attempts MUST produce one accepted campaign and deterministic
rejection responses for all competing attempts.

A campaign becomes inactive only after it reaches a defined terminal state.

### III. Interruption-Safe and Idempotent Processing

Every long-running operation MUST be designed under the assumption that the API, worker,
Redis, PostgreSQL connection, or SMTP connection may be interrupted.

Queue jobs MUST represent bounded and independently retryable work.

Every job MUST have a deterministic identity derived from stable business identifiers.

Recipient delivery records MUST enforce uniqueness for the campaign-recipient combination.

Reprocessing the same queue job MUST NOT create a second intended delivery without explicit
reconciliation.

When SMTP acceptance is uncertain, the system MUST reconcile the attempt before automatically
retrying or MUST terminate it as `DELIVERY_UNKNOWN`.

Restarting the system MUST allow incomplete campaigns to continue without losing accepted
recipients, resetting completed work, or silently duplicating work.

### IV. Validate Before Queueing

Invalid input MUST be rejected before expensive or asynchronous processing begins.

Campaign-level validation MUST complete before the campaign enters an active processing state.

Recipient-level validation MUST occur before a recipient is queued for delivery.

Validation results MUST be persisted, countable, and attributable to specific inputs.

The initial project performs syntax and required-field validation only. It MUST NOT claim
that an email address exists or is deliverable.

### V. Durable State and Reconciliation

Durable application state is the authoritative source for campaign and recipient outcomes.

Queue state and queue-observability tools are operational aids and MUST NOT be treated as the
business system of record.

The system MUST be able to derive and verify, from durable records:

- total submitted recipients;
- total rejected recipients;
- total accepted recipients;
- total pending recipients;
- total sent recipients;
- total failed recipients;
- total recipients with unknown delivery;
- total delivery attempts.

All aggregate counts MUST be reproducible from recipient-level data.

Any mismatch between campaign aggregates and recipient records MUST be treated as a
correctness defect.

### VI. Bounded Work and Controlled Concurrency

Campaign submission MAY represent one logical blast, but processing MUST occur through
bounded batches and bounded worker concurrency.

The system MUST NOT require all recipients to be loaded into application memory at once.

The system MUST NOT depend on a single transaction, single queue job, or single network
request containing the entire campaign workload.

Batch size, worker count, queue concurrency, SMTP concurrency, retry limits, and backoff
settings MUST be configurable.

Defaults MUST be conservative and MUST be justified by measured results.

Backpressure MUST prevent the application from overwhelming PostgreSQL, Redis, the SMTP
target, or the host machine.

### VII. Measured Performance

No throughput, completion-time, concurrency, or scalability claim MAY be accepted without
empirical evidence.

Performance testing MUST progress through increasing recipient counts, including
representative runs such as:

- 1,000 recipients;
- 10,000 recipients;
- 100,000 recipients;
- 1,000,000 recipients, when the environment can support it.

Each benchmark MUST record:

- recipient count;
- message size;
- personalization behavior;
- batch size;
- worker count and concurrency;
- retry configuration;
- application and infrastructure resource limits;
- SMTP target configuration;
- total duration;
- throughput;
- failure count;
- duplicate count;
- unknown-delivery count;
- CPU, memory, disk, PostgreSQL, and Redis observations.

A benchmark result is valid only for the recorded environment and configuration.

### VIII. Observable Failures

Failures MUST be visible through persisted state and structured logs.

Logs MUST include stable campaign, recipient, queue-job, and delivery-attempt identifiers
where applicable.

Expected operational failures MUST produce actionable error categories rather than
unstructured exception text alone.

Queue observability MUST expose waiting, active, completed, delayed, retried, stalled, and
failed work.

Sensitive recipient information and full message bodies MUST NOT be unnecessarily duplicated
in logs.

No recipient may disappear merely because its queue job was removed, expired, retried, or
became stalled.

### IX. Realistic and Failure-Oriented Testing

Correctness MUST be tested using realistic infrastructure boundaries.

Integration tests MUST exercise the actual database, queue, Redis instance, and dry-run SMTP
target rather than replacing all external boundaries with mocks.

Tests MUST cover:

- validation and rejection;
- single-active-campaign enforcement;
- duplicate submissions;
- duplicate queue execution;
- automatic retries;
- retry exhaustion;
- worker interruption before delivery;
- worker interruption during delivery;
- API restart;
- Redis restart;
- recovery of incomplete campaigns;
- campaign-count reconciliation;
- terminal-state transitions;
- behavior under bounded concurrency.

Critical state transitions and invariants MUST have automated tests before they are
considered implemented.

### X. Minimum Sufficient Scope

Implement only behavior required by the approved specification.

New abstractions, services, deployment components, libraries, or architectural layers MUST
have a documented current requirement.

Potential future production requirements MUST NOT be implemented merely to make the design
appear extensible.

Framework capabilities SHOULD be used directly unless wrapping them solves a demonstrated
requirement.

Performance optimizations MUST follow measurement, except where bounded resource use or
correctness requires them from the beginning.

### XI. Traceable Decisions

Every non-trivial architectural decision MUST be documented in the implementation plan that
introduces it.

The documentation MUST include:

- the requirement being addressed;
- alternatives considered;
- the selected approach;
- relevant tradeoffs;
- operational consequences;
- how the decision will be validated.

Unresolved decisions MUST remain explicit. They MUST NOT be silently converted into
implementation assumptions.

## Non-Goals

The initial project explicitly excludes:

- production email delivery;
- integration with production email service providers;
- authentication;
- authorization;
- multi-tenancy;
- user accounts;
- multiple concurrent campaigns;
- campaign scheduling;
- recurring campaigns;
- A/B testing;
- visual email template builders;
- production deliverability management;
- bounce and complaint processing;
- unsubscribe management;
- MX or DNS deliverability verification;
- recipient-existence verification;
- analytics such as opens and clicks;
- production deployment architecture.

Product-specific behavior belongs in feature specifications. Framework and infrastructure
choices belong in implementation plans.

## Governance

All specifications, plans, tasks, and implementations MUST comply with this constitution.

Any constitutional exception MUST be explicitly documented in the relevant implementation
plan, including its justification, scope, risks, and removal conditions.

Constitutional principles take precedence over convenience, undocumented assumptions, and
implementation shortcuts.

Amendments MUST document:

- what changed;
- why it changed;
- which specifications or plans are affected;
- whether existing implementation must be migrated or revalidated.

Amendment versioning follows semantic versioning:

- MAJOR: backward-incompatible principle removals or redefinitions.
- MINOR: new principle or materially expanded guidance.
- PATCH: clarifications, wording, or non-semantic refinements.

Compliance MUST be reviewed during specification clarification, planning, task generation,
and cross-artifact analysis.

**Version**: 1.0.0 | **Ratified**: 2026-07-28 | **Last Amended**: 2026-07-28
