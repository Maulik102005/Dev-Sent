# Command reference

## GitHub triggers

DevSentinel accepts newly created issue comments—not edited comments or pull
request comments—and exact labels on issues.

```text
/devsentinel test
/devsentinel fix
```

Anything after `test` or `fix` is captured rather than discarded. A structured
command is recommended:

```text
/devsentinel fix checkout quantity boundary
Outcome: Multiply every accepted quantity by the unit price
Acceptance: Three units cost three unit prices
Acceptance: Quantity zero follows the issue's documented behavior
Constraint: Preserve monetary values in cents
Scope: src/checkout.js
Exclude: src/shipping.js, src/generated
```

`Outcome`, `Acceptance`, `Constraint`, `Scope`, and `Exclude` may each be
repeated. Scope values are comma-separated repository-relative paths. Absolute,
hidden, wildcard, traversal, and backslash paths are ignored/rejected by the
bounded parser and later validated again. Unprefixed lines become constraints.
If no explicit outcome is present, the same-line text and issue title provide
the issue-scoped request; they do not grant repository-wide authority.

Exact label triggers are:

```text
devsentinel:test
devsentinel:fix
```

A label trigger captures the issue fields but has no command-supplied paths.
Issue discussion is bounded evidence. Later comments do not invisibly change an
active task.

## Clarification continuation

When a FIX run is `AWAITING_CLARIFICATION`, answer the one saved question on the
same issue with the exact run ID:

```text
/devsentinel continue 12345678-1234-1234-1234-123456789abc The zero quantity should return a zero total.
```

The answer may instead start on the next line. It must be 1–4,000 characters.
The webhook accepts it only when repository, issue, actor authorization, open
clarification, and deadline match. Its delivery/comment provenance is stored.
Continuation reuses the saved run, captured SHA, attempt count, token/tool
reservations, and remaining active repair time. Waiting is bounded by the saved
clarification deadline and does not create a fresh repair allowance.

The `continue` command answers a clarification only. It cannot revive a terminal
run, create a new scope, replenish a budget, or authorize publication.

## Operator CLI

Commands read the configured `.env` and act on durable PostgreSQL state:

```bash
pnpm runs list
pnpm runs show <run-id>
pnpm runs cancel <run-id>
pnpm runs retry <run-id>
```

`show` returns the complete persisted run detail. `cancel` is durable and
publication/worker checkpoints recheck it. `retry` asks the database to enqueue
recoverable existing work; it does not reset attempts or budgets and does not
rerun an already completed delivery.

## Dashboard and operations API

Start the system and open:

```text
http://127.0.0.1:3001/dashboard
```

Enter `CONTROL_API_TOKEN` in the lock screen. The token stays in page memory.
Every mutation opens a confirmation dialog explaining its effect.

Authenticated read endpoints:

```text
GET /ops/runs?limit=30&offset=0&status=&mode=&q=
GET /ops/runs/:id
GET /ops/runs/:id/evidence?kind=events|context|inspector&limit=50&offset=0
GET /ops/readiness
GET /ops/metrics
GET /ops/events
```

`/ops/events` is a 25-second fetch-based SSE stream. Send the bearer token in
`Authorization` and the last received cursor in `Last-Event-ID`; never put the
token in a URL.

Authenticated mutation endpoints:

```text
POST /ops/runs/:id/cancel          {"confirmed":true}
POST /ops/runs/:id/retry           {"confirmed":true}
POST /ops/runs/:id/clarification   {"answer":"...","confirmed":true}
POST /ops/runs/:id/scope           {"paths":["src/a.js"],"reason":"...","confirmed":true}
POST /ops/runs/:id/inspect         {"question":"Why did this fail?"}
```

Scope approval is a durable operator record; it does not bypass source policy or
required verification. Inspector POST is read-only. Its answer includes saved
evidence references and cannot launch any of the other endpoints.

The API returns `Cache-Control: no-store`, rejects cross-site/cross-origin
mutations, validates bounded pagination/body schemas, and returns 404 for all
operations when no valid control token is configured.

## Local demo trigger

With the services running:

```bash
pnpm demo:trigger TEST
```

This sends a freshly signed loopback-only example webhook using the secret from
`.env` and prints its accepted run ID. It does not print the secret. See
[the complete demo](demo.md) before using `FIX`.
