# Milestone 2: from durable work to a background worker

This is the milestone-by-milestone learning history. For the complete current
pipeline, continue through [milestones 5–7](05-repair-and-delivery.md).

## What exists now

Milestone 1 stopped after PostgreSQL recorded a run and an outbox event. This
milestone completes the first asynchronous handoff:

```text
PostgreSQL outbox -> dispatcher -> Redis/BullMQ -> worker -> PostgreSQL state
```

Both `TEST` and `FIX` runs use this path. They remain identical until the future
baseline test finishes; a `TEST` run will then report results, while a `FIX` run
will continue into diagnosis and editing.

## The pieces in plain language

### PostgreSQL is the notebook

The run and its status live in PostgreSQL. If Redis is emptied, the job may need
to be delivered again, but the fact that the run exists is not lost.

### The outbox is a durable to-do list

An unpublished outbox row means "this work still needs to enter the queue." It
is created in the same transaction as the run, so a committed run cannot exist
without its first handoff instruction.

### The dispatcher is the delivery person

The dispatcher polls for unpublished rows. Before publishing one, it writes its
unique owner ID and a lease timestamp. Other dispatchers skip that row while
the lease is fresh.

If the dispatcher dies, the lease eventually expires and another instance can
try again. Database row locks with `SKIP LOCKED` let several dispatchers claim
different rows without waiting on each other.

### Redis/BullMQ is the waiting line

BullMQ stores jobs until a worker can process them. Every job gets a stable ID
derived from the outbox event ID. Publishing the same outbox event twice
therefore points at the same logical queue job while it is retained.

This is useful duplicate protection, but it is not our only protection. Queue
records are eventually cleaned up, and workers can be retried after crashes.

### The worker is the background employee

The worker validates the job data, loads the run from PostgreSQL, checks its
current state, performs authorization, and conditionally changes:

```text
AUTHORIZING -> PREPARING
AUTHORIZING -> REJECTED
```

The SQL update includes `WHERE status = 'AUTHORIZING'`. If the same job runs
again, it sees that authorization is already finished and does nothing. The
run's version increases only for the winning state change.

## The failure window we test

The most interesting integration test deliberately does this:

```text
1. Dispatcher sends job to Redis successfully.
2. Pretend the dispatcher crashes before updating published_at.
3. Worker processes the job and advances the run.
4. A new dispatcher sees the outbox row as unpublished and sends it again.
5. Stable queue ID and worker state check prevent duplicate authorization.
6. The new dispatcher finally marks the outbox row published.
```

This demonstrates **at-least-once delivery**: delivery may happen more than
once, so processing must be safe more than once. We are not claiming magical
exactly-once delivery across PostgreSQL and Redis.

## Why authorization is still local-only

The worker currently accepts only this explicit setting:

```text
AUTHORIZATION_MODE=development-allow-all
```

The long name and startup warning are intentional. It lets us prove the queue
and state mechanics without pretending a GitHub permission check exists. It
must never be used for a public deployment.

The next milestone replaces this adapter with a GitHub App authorizer that uses
a short-lived installation token and a documented permission policy.

## Read the code in this order

1. `packages/database/src/outbox.ts` — lease, claim, publish, and retry state.
2. `packages/queue/src/authorization.ts` — stable queue/job contract.
3. `apps/dispatcher/src/dispatch.ts` — PostgreSQL-to-Redis handoff.
4. `apps/worker/src/process-authorization.ts` — idempotent state transition.
5. `apps/worker/src/authorization.ts` — replaceable authorization boundary.
6. `apps/worker/src/authorization-pipeline.integration.test.ts` — real Redis,
   real PostgreSQL, denial, replay, and simulated-crash proof.

## Run it

```bash
# First setup only; do not overwrite an existing .env.
test -f .env || cp .env.example .env
docker compose up -d postgres redis
pnpm db:migrate
pnpm test:integration
pnpm dev
```

`pnpm dev` starts three long-running processes: API, dispatcher, and worker.
Stop them with Ctrl+C. PostgreSQL and Redis continue in Docker until you run
`docker compose down`.

## What you should understand before moving on

- Why PostgreSQL, not Redis, owns the run status.
- Why a dispatcher needs a lease when multiple copies may run.
- What happens if a process dies after publishing but before acknowledging.
- Why a stable BullMQ job ID helps but does not replace worker idempotency.
- Why `TEST` mode still requires authorization and a sandbox.
- Why `development-allow-all` is an adapter rather than hidden production
  behavior.
