# Final MVP implementation checklist

This checklist tracks the release described in `FINAL-BUILD-HANDOFF.md`. A
checked item means the implementation and its focused tests are complete. The
observed release-gate outcomes are recorded in [RELEASE-EVIDENCE.md](RELEASE-EVIDENCE.md).

## Milestone 1 — Understand and preserve scope

- [x] Persist an immutable task brief, command context, acceptance criteria,
  constraints, actor provenance, and captured revision.
- [x] Parse issue-scoped command context without silently broadening authority.
- [x] Add one explicit, authorized clarification continuation syntax.
- [x] Persist clarification checkpoints and deadlines.

## Milestone 2 — Guided, bounded investigation

- [x] Load schema-validated repository configuration and maintainer guidance
  from the captured revision.
- [x] Separate platform rules, repository guidance, task instructions, and
  untrusted evidence.
- [x] Provide phase-limited list/search/read/test/clarification/proposal tools.
- [x] Persist a concise plan and context-selection provenance.
- [x] Enforce tool/path permissions, secret filtering, sandbox limits, and
  per-phase model/tool budgets in application code.
- [x] Preserve remaining budgets across retries, crashes, and clarification;
  repository guidance cannot override platform limits.

## Milestone 3 — Verification, recovery, and reporting

- [x] Classify terminal and paused outcomes honestly.
- [x] Preserve useful empty-proposal explanations and stop repeated attempts.
- [x] Compare baseline and candidate evidence against acceptance criteria.
- [x] Treat “acceptance criteria verified” as a recorded execution-evidence
  state, never as a model assertion.
- [x] Freeze an audited regression reproducer when the existing suite is green;
  prove it fails before source repair and passes afterward without weakening
  existing tests.
- [x] Identify unrelated baseline failures and block verified delivery while
  required checks remain red unless a confirmed review-only exception exists.
- [x] Make exhausted infrastructure work terminal and delivery independently
  retryable.
- [x] Render a complete evidence-backed report and meaningful progress events.
- [x] Resolve commit authorship from the configured GitHub App and preserve
  permission rechecks, patch matching, branch drift, and publication recovery.

## Milestone 4 — Developer review console

- [x] Replace the JSON console with a responsive, accessible run overview and
  workspace.
- [x] Add bounded/paginated evidence APIs, readiness data, safe diff rendering,
  human controls, and authenticated resumable live progress.
- [x] Add the read-only, evidence-grounded AI run inspector with a deterministic
  fallback, separate usage limits, and evidence citations.
- [x] Keep credentials server-side and out of URLs; require confirmation for
  every inspector-suggested mutation.
- [x] Cover loading, empty, disconnected, expired-auth, failure, and partial
  result states at desktop and mobile sizes.
- [x] Complete visual QA for typography, spacing, diff/log readability,
  dark/light themes, keyboard use, reduced motion, and responsive layouts.
- [x] Use the configured GitHub App identity and logo, friendly display labels,
  and public reports that keep usage and cost accounting in the private console.

## Milestone 5 — Proof and handoff

- [x] Add deterministic unit, integration, browser, and agent-evaluation
  coverage.
- [x] Verify both fresh setup and an additive upgrade with historical runs and
  unknown model usage preserved.
- [x] Update architecture, ADRs, configuration, commands, recovery, threat
  model, demo, learning guide, and README.
- [x] Add original, editable, and accessible end-to-end, repair-flow, and
  security-gate SVG diagrams.
- [x] Run typecheck, build, unit, isolated integration, browser, and evaluation
  checks and record exact outcomes.
- [x] Provide startup/demo commands, limitations, activation steps, and an
  honest completion summary that distinguishes mocks from live provider and
  GitHub verification.
