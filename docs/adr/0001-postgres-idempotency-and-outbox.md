# ADR 0001: PostgreSQL idempotency and transactional outbox

- Status: accepted
- Date: 2026-08-31

## Context

GitHub webhooks and background queues use at-least-once delivery. DevSentinel
must tolerate retries and concurrent duplicates without starting multiple fixes
for one event. It must also create a run and arrange background processing even
if the API crashes between those actions.

PostgreSQL and Redis cannot participate in one ordinary local transaction.
Application-level duplicate checks also have a check-then-act race.

## Decision

1. Store every authentic webhook in `webhook_deliveries`.
2. Use GitHub's delivery ID as an idempotency key enforced by a PostgreSQL unique
   index.
3. Insert the delivery, run, and first outbox event in one PostgreSQL
   transaction.
4. Return success for duplicate delivery IDs without creating more work.
5. Dispatch unpublished outbox rows to BullMQ and mark them published only
   after a successful enqueue.
6. Treat queue consumers as idempotent because a dispatcher or worker may retry.

## Consequences

Benefits:

- Concurrent webhook retries have one database-enforced winner.
- A committed run always has a durable record of work to publish.
- Queue downtime does not require GitHub to resend the webhook.
- PostgreSQL remains the inspectable source of truth.

Costs:

- An outbox dispatcher and backlog monitoring are required.
- Publication is still at least once: a crash after enqueue but before marking
  `published_at` can enqueue the event again.
- Consumers need stable job identifiers or equivalent idempotent behavior.
- Old webhook payloads and outbox rows need an explicit retention policy.

## Rejected alternatives

**Check then insert in application code:** unsafe under concurrency unless the
database still enforces uniqueness, in which case the preliminary read adds no
correctness.

**Publish directly to Redis after committing:** creates a lost-work window if
the process exits before publication.

**Publish before committing:** allows a worker to observe work whose run never
committed.

**Use Redis as workflow truth:** queue retention, eviction, or operational loss
would erase durable business state and auditability.
