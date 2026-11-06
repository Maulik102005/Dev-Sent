# Milestone 1: from webhook to durable work

## What you are learning

This slice looks small, but it introduces four production systems concepts:

1. **Trust boundaries:** network input is untrusted until authenticated and
   validated.
2. **At-least-once delivery:** a sender may retry, so duplicate events are normal
   rather than exceptional.
3. **Atomicity:** related database changes should all happen or none should
   happen.
4. **Asynchronous boundaries:** an HTTP handler records work quickly; slow work
   happens later in a worker.

No LLM belongs in this milestone. Before DevSentinel can reason about code, it
must reliably decide which event it is reasoning about.

## Follow one request

### 1. Preserve the raw body

GitHub computes an HMAC-SHA256 signature from the exact bytes it sent. Parsing
JSON and serializing it again can change whitespace or key order, so the API's
JSON content parser returns a `Buffer`. See
`apps/api/src/app.ts`.

### 2. Authenticate the sender

`verifyGitHubSignature` computes the expected HMAC from the configured webhook
secret and compares it with `timingSafeEqual`. It also checks the prefix and
length before comparing. A malformed or forged request returns `401` and is not
persisted.

Authentication answers: **was this payload signed with our shared secret?** It
does not answer: **is the actor allowed to ask DevSentinel to change code?** The
latter needs GitHub App authorization and is deliberately represented by the
run's `AUTHORIZING` state.

### 3. Validate intent, not just JSON

The domain package accepts two operations through labels or commands:

- `devsentinel:test` or `/devsentinel test` creates a `TEST` run;
- `devsentinel:fix` or `/devsentinel fix` creates a `FIX` run.

`mode` answers what to do (`TEST` or `FIX`). `activation` answers how the user
asked (`label` or `command`). Keeping them separate avoids an overloaded field.

Zod checks the subset of GitHub's payload needed by the system. Pull request
comments are ignored because v1 is an issue-to-new-PR flow. Framework-free
trigger logic lives in `packages/domain/src/github-webhook.ts`, which makes it
fast to test without HTTP or a database.

### 4. Claim the delivery atomically

GitHub's `X-GitHub-Delivery` header is the idempotency key. The database has a
unique index on it. The ingestion transaction attempts:

```sql
INSERT INTO webhook_deliveries (...)
ON CONFLICT (delivery_id) DO NOTHING
RETURNING id;
```

Only one concurrent request can receive an inserted row. Every loser recognizes
the duplicate and returns successfully without creating another run.

A tempting implementation is:

```text
SELECT whether delivery exists
if not: INSERT delivery
```

That is a race. Two requests can both observe "not found" before either inserts.
The unique constraint lets PostgreSQL serialize the decision correctly.

### 5. Commit the run and intent to dispatch together

For a valid trigger, one transaction inserts:

- the webhook receipt;
- a run in `AUTHORIZING`;
- an outbox event named `run.authorization.requested`.

Why not insert the run and immediately publish to Redis?

```text
commit database -> process crashes -> queue publish never happens
publish queue -> database commit fails -> worker sees a run that does not exist
```

A normal transaction cannot atomically commit PostgreSQL and Redis. The
transactional outbox records the intention to publish in the same database
commit. A later dispatcher can retry unpublished rows until queue delivery
succeeds.

## Responses and their meaning

| Response | Meaning | Database effect |
|---|---|---|
| `401` | Signature is missing or invalid | None |
| `400` | Required headers/body are malformed | None |
| `200 { ignored: true }` | Authentic event, but not a DevSentinel trigger | Delivery is audited |
| `200 { duplicate: true }` | This GitHub delivery was already claimed | No additional rows |
| `202 { accepted: true }` | Durable work was created | Delivery + run + outbox event |

`202 Accepted` is intentional: the remediation has not completed; the service
has only accepted responsibility for processing it asynchronously.

## Read the code in this order

1. `apps/api/src/github-signature.ts` — a small, pure security boundary.
2. `packages/domain/src/github-webhook.ts` — payload validation and trigger
   policy.
3. `packages/database/src/schema.ts` — the durable model and constraints.
4. `packages/database/src/webhook-ingestion.ts` — the atomic write path.
5. `apps/api/src/app.ts` — orchestration at the HTTP boundary.
6. `apps/api/src/github-webhook.integration.test.ts` — executable proof of the
   cross-component behavior.

## Run and inspect it

```bash
docker compose up -d postgres redis
pnpm db:migrate
pnpm typecheck
pnpm test
pnpm test:integration
```

The integration suite sends ten identical requests concurrently. The important
assertion is not merely that one request says `202`; it also queries PostgreSQL
and proves there is exactly one run and one outbox row.

## Your exercises

Try these in order. Each changes one concept without expanding the architecture:

1. Add a unit test showing `/devsentinel fix-this` is ignored, while
   `/devsentinel fix please` is accepted. Explain the regular expression before
   running the test.
2. Add a test for malformed JSON with a valid signature and verify that nothing
   is persisted.
3. Temporarily remove the unique delivery index, then predict what the ten-way
   concurrency test can do. Restore it before proceeding.
4. Add a `reason` field to ignored deliveries. Decide whether it belongs in an
   enum, text column, or audit-event table and write down the tradeoff.

Exercise 3 is intentionally a local experiment. Do not keep the unsafe schema.

## Questions you should now be able to answer

- Why must signature verification use raw bytes?
- Why is signature verification not actor authorization?
- Why is a database uniqueness constraint stronger than an application lookup?
- What failure window does the outbox close?
- Why does accepting a webhook return `202` instead of waiting for the fix?
- Which component owns durable state, and which component will only transport
  jobs?

If any answer feels fuzzy, trace one request through the six files above before
moving to the worker. The next milestone builds directly on these guarantees.
