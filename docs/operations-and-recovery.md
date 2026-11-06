# Operations and recovery

## Start, observe, stop

Use the repository root and the documented startup sequence:

```bash
docker compose up -d --wait postgres redis
pnpm db:migrate
pnpm build
pnpm dev
```

The API health endpoint is `GET /health`; authenticated readiness is
`GET /ops/readiness`. The latter reports database state, authorization and
repository-source modes, model/inspector mode, delivery mode, allowlist count,
pending outbox work, and durable dead-letter count without revealing secrets.

Stop the foreground `pnpm dev` process with Ctrl+C before applying a migration.
Do not use `docker compose down -v`: the named PostgreSQL/Redis volumes may
contain development history. Back up valuable PostgreSQL data before a
production-like upgrade.

## Read the evidence first

Use the dashboard or:

```bash
pnpm runs list
pnpm runs show <run-id>
```

Correlate the run ID across the task brief, plan, execution rows, attempts, tool
trace, criteria evidence, clarifications, approvals, events, delivery checkpoint,
and structured worker logs. Bounded logs may be truncated; that fact is stored.
Unknown token usage remains null and reports as unknown, never zero.

Primary statuses and actions:

| Dashboard label (database code) | Meaning | Normal action |
| --- | --- | --- |
| **Waiting for answer** (`AWAITING_CLARIFICATION`) | One saved question is open until its deadline. | Submit an authorized explicit answer. |
| **Needs review** (`NEEDS_HUMAN`) | Safe autonomy stopped because intent, reproduction, policy, or a patch result needs a decision. | Review the saved reason and evidence; start or resume correctly scoped work when appropriate. |
| **Run limit reached** (`BUDGET_EXHAUSTED`) | The attempt/model/tool/time admission limit was reached. | Review it; configuration changes apply to a new run, not a hidden reset. |
| **Could not complete** (`FAILED`) | A required TEST/baseline or terminal infrastructure/configuration step failed. | Correct the saved cause; resume only when the current checkpoint permits it. |
| **Publishing review** (`PUBLISHING`) | Repair evidence is complete; GitHub delivery is unfinished. | Restore permission/connectivity and resume delivery without rerunning repair. |
| **Completed** (`SUCCEEDED`) | A local report or external review delivery completed as labelled. | Check `delivery.mode` and artifact links; a dry run is not a PR. |
| **Cancelled / Not authorized** (`CANCELLED` / `REJECTED`) | The operator cancelled or authorization was denied. | Start a new authorized run if appropriate. |

Failure classification gives the more precise category. `VERIFIED_UNDELIVERED`
does not mean a published PR and never permits the UI/report to call the
delivery complete.

## Safe recovery

```bash
pnpm runs retry <run-id>
```

Recovery asks PostgreSQL to enqueue the next step derived from saved state. A
terminalized `VERIFIED_UNDELIVERED` run with an exact delivery-eligible attempt
returns to `PUBLISHING` for delivery only. Recovery otherwise does not delete
BullMQ data, change the captured commit, refund uncertain model
calls, reset tools, reopen expired clarification, or regenerate a verified
patch. Completed delivery and cancelled states reject recovery.

A worker crash can leave a lease until expiry. Wait for the fenced lease to
expire, then use recovery if the outbox/dead-letter state requires it. Never
manually edit ownership fields. A stale worker cannot checkpoint after takeover.

After a transient model or GitHub error:

1. Inspect sanitized diagnostics and the last run event.
2. Restore service/provider connectivity or installation permission.
3. Confirm the run is still within durable attempt/time limits.
4. Retry once through the dashboard or CLI.
5. Verify the status and delivery checkpoint rather than assuming the request
   response represented a completed side effect.

GitHub publication uses a stable branch, single-parent commit/tree verification,
App-owned run marker, draft PR lookup, and Check/comment reconciliation. If the
default branch moved or an existing branch/PR was modified, start a fresh run;
do not force-update it.

GitHub comments and PR text deliberately exclude model allowances, token usage,
attempt accounting, tool counts, and cost estimates. Inspect those only through
the authenticated dashboard, CLI, metrics, or database evidence.

## Cancellation and permissions

Dashboard actions require explicit confirmation. Cancellation becomes durable
first; workers and the publisher check it at controlled boundaries. No system
can retract a request GitHub has already accepted during the small in-flight
network race, so inspect external artifacts after cancellation.

Actor permission is checked during authorization, before costly repair, and
before publication. Losing permission blocks the next gate. Do not work around
this by lowering required permission without an explicit security decision.

## Dead letters and queues

The dispatcher leases unpublished PostgreSQL outbox records and publishes stable
BullMQ job IDs. PostgreSQL retains the work if Redis is flushed. Failed outbox
and workflow records preserve bounded errors and appear in readiness/metrics.

Correct the cause, then use the supported recovery action. Do not:

- truncate workflow tables;
- reset attempt counters;
- delete the outbox row;
- flush shared Redis to “unstick” one run;
- remove development volumes;
- manually force a delivery branch.

## Metrics and live events

`/ops/metrics` returns Prometheus text for run status counts, pending outbox,
dead letters, repair token reservations, and inspector token reservations.
It is bearer-protected in this MVP.

The dashboard reconnects to authenticated `/ops/events` with `Last-Event-ID` and
falls back to bounded list/detail refresh. The bearer credential is a header,
not a query parameter. A 401 returns the UI to its locked state; it never writes
the token to local/session storage.

## Database upgrade

Migrations are additive and ordered through `0008_parallel_quasar.sql`.
Migrations 0006–0008 add briefs/plans/context/clarifications/inspector records,
failure classification, scope approvals, tool and inspector budgets, criteria
and regression evidence, configured-rate cost storage, and bounded context
content.

The integration upgrade proof creates a database at migration 0005, inserts a
historical run whose usage is unknown, applies all current migrations twice, and
asserts that the run and null usage remain. This proves the tested schema path;
it does not replace an operator backup or claim that an untested vendor-specific
production restore works.

## Incident notes

Do not paste provider bodies, keys, PEM material, control tokens, or raw private
logs into GitHub. Reports use bounded redaction and keep detailed logs in the
authenticated console. If a credential might have entered repository content
or captured logs, stop the affected service, rotate that credential through its
provider, preserve only sanitized incident evidence, and review retention.

See [the threat model](threat-model.md) and [go-live checklist](GO-LIVE.md).
