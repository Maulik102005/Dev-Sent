# Release evidence — 2026-09-10

This record covers the final issue-scoped local MVP implementation described by
`FINAL-BUILD-HANDOFF.md`. Counts are observed command output, not model claims.

## Executed checks

| Command | Observed outcome |
| --- | --- |
| `pnpm build` | Passed: dashboard and demo-script syntax; TypeScript in all 7 workspace packages. Turbo emitted the known warning that the root is not a Git repository. |
| `pnpm test` | Passed: 20 files, 125 tests, including App-identity authorship, bounded pagination, duplicate-publication recovery, and public-report privacy. |
| `pnpm test:evaluation` | Passed: 1 file/test, 4 deterministic cases; resolution rate 1, scope-violation block rate 1, supported/unsupported verification signals true, model calls/tokens 0, one source edit, 7.11 ms measured evaluation latency. |
| `DEVSENTINEL_TEST_NETWORK=host pnpm test:integration` | Passed: 7 files, 45 tests against disposable PostgreSQL, Redis, BullMQ, and real Docker; 38.91 s. |
| `DEVSENTINEL_TEST_NETWORK=host pnpm test:browser` | Passed: 1 authenticated Chrome journey with real API/database evidence; 6.21 s suite, 2.876 s journey. |

The integration proof includes real pass/fail/timeout containers and cleanup,
webhook idempotency, authorization, snapshot baseline, repair/retry/crash and
clarification budgets, provider error classification, cancellation/permission
races, audited regression failure-before/success-after, publication recovery,
protected test/mutation rejection, operations API/inspector behavior, and
database upgrade.

The regression path uses a real Node fixture in Docker. Its unchanged existing
suite first passes, the newly frozen issue reproducer fails against original
source, and the exact same reproducer plus the complete suite pass after the
candidate source patch. The test and source hashes are rechecked before a patch
can become delivery-eligible.

The browser proof checks accepted and rejected access, keyboard search, empty
results, real run navigation, task evidence, grounded inspector citation,
selected-log persistence during live refresh, and absence of the bearer token
from the URL, local/session storage, and resource URLs. It also asserts no
runtime exceptions, separated desktop columns, a 390 px layout with no document
overflow, dark/light theme persistence, and reduced-motion behavior. Final
desktop, light, evidence, and mobile captures were visually inspected for
typography, spacing, status hierarchy, cards, and diff/log readability.

One expanded browser run exposed a race between simultaneous rejected readiness
requests that could change the access error text. The dashboard now uses one
stable message, and the final browser run above passed with the regression check
in place.

The documentation includes three hand-authored, accessible SVGs covering the
end-to-end architecture, repair journey, and six security/evidence gates. The
README and dashboard use the public logo configured on GitHub App ID `4855052`.
Machine states are translated for people—for example, `NEEDS_HUMAN` is shown as
**Needs review**—while exact machine codes remain available in durable state.

GitHub-facing publisher tests verify that the progress comment, draft PR, Check,
and final issue comment contain the request, approved scope, changed files,
recorded checks, acceptance evidence, blockers, and next step. They reject
visible attempt counts, model/tool allowances, token usage, and cost estimates;
that accounting remains in the authenticated operator console only.

## Database evidence

Fresh integration databases apply every migration through
`0008_parallel_quasar.sql`.

The explicit upgrade test creates a separate database at migration 0005, inserts
a historical run/attempt with unknown token usage, applies current migrations,
reapplies them to prove idempotent startup, and verifies historical identity and
null usage were preserved. No development database or named development volume
was migrated, truncated, flushed, or removed during this release proof.

## Claim boundary

Unit and most agent integration paths use deterministic provider and GitHub HTTP
doubles. Sandbox integration and browser execution are real local processes.
The offline evaluation is not paid/live-provider evidence.

Project history supplied in the handoff records an older live model dry-run and
older live draft-PR publication. Those runs predate this complete issue-scoped
agent, regression, budget, and inspector contract. No paid live evaluation, new
GitHub artifact, push, deployment, or current-contract live publication was
authorized or performed in this release. Activate those steps explicitly through
`GO-LIVE.md`.

“Acceptance criteria supported” in the product means a stored criterion linked
to successful execution evidence. It does not mean that an AI declared the task
satisfied, that tests prove all semantics, that a draft PR was published, or
that code was merged.
