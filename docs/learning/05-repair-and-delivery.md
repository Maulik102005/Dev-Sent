# Issue-scoped repair, evidence, and delivery

This chapter explains the finished agent path in plain language. The key design
choice is that the model helps investigate and propose; the application decides
authority, budget, execution, verification, and publication.

## 1. Turn a comment into a durable contract

A command such as:

```text
/devsentinel fix quantity boundary
Outcome: Charge one unit price per accepted item
Acceptance: Three items cost three unit prices
Scope: src/checkout.js
Constraint: Preserve amounts in cents
```

is not just a trigger. DevSentinel stores the complete comment, issue title/body,
structured context, authorized actor, GitHub delivery/comment/timestamp
provenance, approved/excluded paths, and the versioned global contract in an
immutable task brief. Later snapshot capture seals its exact commit and the
content/hash/version of captured `DEVSENTINEL.md` and `.devsentinel.json`.

Why persist this? A queue retry or restart must know the same request. A later
issue comment is evidence, not a silent rewrite of authority.

## 2. Keep four kinds of input separate

The repair model sees an explicit hierarchy:

1. Global platform rules: fixed and versioned in code.
2. Authorized task: the sealed outcome, criteria, constraints, and scope.
3. Maintainer guidance: captured repository conventions.
4. Evidence: issue discussion, source, tests, logs, and tool output.

Levels three and four cannot increase permissions or budgets. Treating a README
sentence like “ignore all limits” as an instruction would make repository
content an authorization mechanism. Instead it remains untrusted evidence.

## 3. Investigate through narrow tools

The single agent moves through understand, investigate, plan, and patch phases.
It may list bounded text files, search for a literal, read at most a bounded line
range, request an approved package-test profile, submit a concise plan, ask one
clarification, propose a separately audited regression test, or submit a source
patch.

Those are model-callable functions, not unrestricted capabilities. The
application:

- allows different functions by phase;
- validates strict argument schemas and returned evidence;
- rejects unsafe/hidden/linked/binary/oversized/secret-like paths/content;
- intersects repository source prefixes with task scope and exclusions;
- limits patchable content to code extensions under those configured prefixes;
- maps test profiles to application-owned argv rather than accepting commands;
- limits calls, output bytes, context bytes, model turns, and wall time;
- never exposes a host shell, arbitrary URL, database, credential, or GitHub
  write function.

The model must save a plan containing suspected cause, evidence references,
intended files, scope exclusions, and verification steps before patching. This
is a reviewable artifact, not hidden chain-of-thought.

## 4. Reserve cost before uncertainty

`run_workflows` is the durable budget ledger. Before a model call, DevSentinel
reserves an attempt, conservative token units, and that attempt's share of the
remaining tool calls/output. The reservation commits before contacting the
provider.

That order handles the difficult case: the provider could process a request
while the worker loses the response. Refunding it would allow repeated unknown
spend. The next retry sees the existing reservation and cannot silently buy the
call again. A clarification answer requeues the same run and counters. Bounded
time spent awaiting an answer is excluded from active repair time, so the saved
remainder—not a fresh 15 minutes—continues after the answer. The clarification
deadline and attempt cap prevent unlimited calendar-time pauses.

Actual input/output tokens are stored when available. Null means unknown—not
zero. Optional operator-supplied per-million-token rates produce a labelled
micro-USD estimate. Reservations are admission units and the estimate is not an
invoice; provider-side spend controls are still required.

The read-only inspector uses its own query/token counters so chat cannot consume
or reset repair capacity.

## 5. Clarify instead of guessing

If essential intent is missing, the agent may ask one specific question. The
application saves the question, deadline, attempt checkpoint, and remaining
budgets, then sets `AWAITING_CLARIFICATION`.

Only a new authorized comment on the same repository/issue with exact syntax can
continue it:

```text
/devsentinel continue <run-uuid> <bounded answer>
```

The answer and GitHub provenance are durable. Expired, mismatched, duplicate,
unauthorized, or terminal continuations are ignored/rejected. The continuation
does not grant broader file scope.

## 6. Preserve the oracle

For a normal reproduced failure, each proposal is a complete cumulative patch
against captured commit A. DevSentinel fetches a fresh A, applies only the saved
source edits, runs locked install and application-selected targeted/full-suite
tests in Docker, and compares fingerprints. It does not layer an unknown dirty
workspace from a prior attempt.

Existing test, manifest, lock, workflow, hidden, executable, symlink, and other
protected changes fail policy before publication. A zero test exit is rejected
if verification mutated protected repository content.

### When the baseline is green

A green unchanged suite does not reproduce the reported bug. Default behavior is
an honest `UNREPRODUCED_BUG` stop—not a speculative repair.

A controlled exception can create one new focused reproducer only when the
operator environment and captured repository configuration both enable it. The
model proposes its path/content; the application validates and hashes it, then:

```text
captured source A + frozen new test -> test must fail
captured source A + exact frozen test + source patch -> targeted test must pass
same candidate + all existing tests -> full suite must pass
```

The source patch cannot alter the frozen test. Publication hashes it again and
requires the exact stored before/after records. This demonstrates the requested
failure signal without weakening the previous suite.

## 7. Decide from evidence, not prose

Passing tests are necessary but not proof of semantic correctness. DevSentinel
therefore stores each acceptance criterion with evidence references and one of:

- `SUPPORTED`: supporting targeted/candidate execution ran and passed.
- `UNVERIFIED`: the required execution evidence is absent or red.

The model cannot choose these values. The product renders the first as a checked
acceptance item backed by named saved checks—not “the AI says verified.”

Baseline and candidate failures are compared. Failures unrelated to the approved
issue remain visible and make required checks red. The agent does not modify
unrelated source just to achieve green. This release provides no review-only
exception: required red means `deliveryEligible=false` and publication is
blocked.

Repeated identical patches/failures stop early. Empty proposals preserve the
model's useful bounded explanation. Outcomes classify unclear tasks,
unreproduced bugs, policy blocks, unsuccessful patches, budget exhaustion,
permanent configuration, transient infrastructure, cancellation, and
verified-but-undelivered delivery separately.

## 8. Publish without trusting the model

A verified source proposal is still only data. Before GitHub writes, the worker
rechecks cancellation and current actor authorization. The publisher resolves
the configured App's slug and bot account to derive both commit author and
committer—there is no repository-specific hardcoded identity.

It verifies that the default branch still equals captured A, builds a tree from
A, makes a single-parent commit, creates `devsentinel/run-<uuid>` without force,
and opens a draft PR. It re-hashes saved edits and verifies an existing
commit/tree/parent when reconciling retries.

Stable run markers and App ownership reconcile one progress/final comment,
Check, branch, and PR even after a response is lost. Progress updates happen at
meaningful investigating, verifying, and publishing checkpoints. Successful
repair is not rerun merely because delivery needs recovery.

A dry-run stores the full operator report and writes nothing to GitHub. When
GitHub delivery is enabled, the public review surfaces intentionally omit model
allowances, tool counts, attempt accounting, and cost estimates. Those belong in
the authenticated dashboard; reviewers see the requested outcome, changed
files, checks, acceptance evidence, blockers, and next step.
`PUBLISHING` means eligible evidence exists but delivery is unfinished.
`SUCCEEDED` is interpreted together with saved delivery mode/artifacts. Nothing
automatically merges.

## 9. Inspect safely

The dashboard presents runs, readiness, task scope, plan, timeline, tool trace,
diff, baseline/candidate results, logs, budgets, criteria evidence, delivery,
clarification, and confirmed controls. It uses bounded/paginated APIs and
authenticated resumable SSE.

Machine statuses remain stable for database compatibility, while the interface
uses plain labels: “Needs review,” “Waiting for answer,” “Run limit reached,”
and “Could not complete.”

The token stays in page memory and Authorization headers. CSP, no-store,
no-referrer, safe text rendering, and cross-origin mutation checks reduce browser
exposure. Light/dark themes, keyboard focus, reduced motion, desktop/mobile
layouts, partial/error/empty/auth states, and log/diff readability are part of
the tested product—not fake decoration.

The inspector builds a bounded fact list from authorized run evidence. A model
answer may cite only supplied IDs; provider errors fall back to deterministic
facts. It cannot call mutation endpoints. Cancel, retry, answer, and scope
approval are separate actions with explicit confirmation.

## 10. Recover and prove

PostgreSQL leases are fenced: an old worker cannot checkpoint after takeover.
Cancellation and permission are checked at controlled boundaries. BullMQ is
at-least-once transport; PostgreSQL outbox/workflow state survives Redis loss.
Exhausted infrastructure retries record a terminal reason/dead-letter rather
than leaving an active-looking run.

Unit tests cover contracts and policy with doubles. Integration tests use
disposable PostgreSQL, Redis, BullMQ, and real Docker. The database upgrade test
starts at migration 0005 and proves current additive migrations preserve a
historical run and unknown usage. The browser journey uses real API/database
evidence and Chrome at desktop/mobile sizes. The deterministic evaluation
reports resolution, scope-block, verification, classification, latency, and
usage signals.

These are different claims:

- mock provider + real sandbox proves orchestration and safety gates;
- live provider dry-run proves that one configured model can participate;
- live GitHub delivery proves the App can create/reconcile artifacts;
- none proves general AI quality, semantic correctness, or public production
  isolation.

Use [the demo](../demo.md), [operations guide](../operations-and-recovery.md),
and [go-live checklist](../GO-LIVE.md) for the next step.
