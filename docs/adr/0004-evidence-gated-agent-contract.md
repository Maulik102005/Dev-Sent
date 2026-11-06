# ADR 0004: evidence-gated, issue-scoped agent contract

- Status: Accepted
- Date: 2026-09-10

## Context

The earlier repair loop sent a fixed context bundle to a model and accepted
complete source-file replacements when the unchanged full suite passed. Extra
command text and relevant issue discussion were not durable task input. A green
baseline stopped even when the issue described a missing test. Repository
instructions, model tools, explicit planning/clarification, issue-scoped
acceptance, unrelated-failure handling, and a safe operator inspector were
missing.

A prompt alone cannot enforce authority, budgets, path safety, or truthfulness.
Retries and clarification can accidentally replenish in-memory limits. Passing
an unchanged suite may not reproduce the requested bug, while editing tests to
make a patch pass would destroy the evidence.

## Decision

Use one agent with an application-owned contract:

1. Persist and later seal an immutable task brief containing the complete trigger,
   actor/source provenance, outcome, criteria, constraints, explicit path scope,
   captured commit, and captured guidance/config hash.
2. Keep versioned global rules in code. Treat maintainer guidance as convention
   and repository/comments/logs/model output as untrusted evidence. None may
   grant permission, increase budgets, select host commands, or reveal secrets.
3. Expose only bounded phase-specific list/search/read, approved package-test
   request, plan, clarification, audited reproducer, and patch functions. Validate
   every request and result in the application.
4. Reserve attempts, token units, tool calls/output bytes, inspector use, and
   deadlines durably before uncertain work. Do not refund unknown outcomes or
   reset counters across retries, crashes, or clarification.
5. Preserve the captured-original/cumulative-patch invariant. Existing tests are
   immutable.
6. If the unchanged suite is green, allow one new reproducer only behind both
   operator and captured-repository gates. Freeze and hash it, prove failure with
   original source, then require it and the unweakened full suite to pass after
   the source patch.
7. Compute acceptance support from saved execution evidence. The model cannot set
   it. Any required or unrelated red check blocks delivery. This release has no
   review-only exception.
8. Keep GitHub writes in a deterministic application gate with current permission,
   cancellation, exact patch/tree/parent, default-branch drift, App identity, and
   duplicate-publication checks.
9. Make the run inspector separately budgeted and read-only. It may cite only
   supplied authorized evidence and every state-changing control requires an
   explicit confirmation.

## Consequences

The workflow is more conservative. It may stop when a human could infer a safe
fix, and durable reservations may over-count a timed-out provider call. A green
repository cannot be repaired unless the separate reproducer gate is enabled.
A red unrelated required check prevents a “verified” delivery rather than
silently broadening the issue. These are intentional trust decisions.

More state is stored: briefs, context provenance, plans, clarifications,
approvals, tool traces, regression before/after evidence, criteria mappings,
failure classifications, inspector queries, and separate budgets. Additive
migrations backfill historical runs with an explicitly labelled legacy brief
and preserve unknown usage.

The UI can now explain why work stopped and what evidence supports each claim.
The report uses “supported by execution,” not an AI assertion of semantic
completion. Human review remains mandatory and PRs remain drafts.

## Rejected alternatives

- **Prompt-only limits:** model compliance is not an authorization boundary.
- **Unrestricted shell/browser/GitHub tools:** unnecessary credential and host
  exposure for the supported Node.js workflow.
- **Resetting budget on retry or clarification:** turns failure handling into an
  unbounded-cost path.
- **Letting the agent edit existing tests:** allows weakening the oracle.
- **Treating a green unchanged suite as proof:** it can simply lack a reproducer.
- **Repairing unrelated failures to get green:** violates issue-scoped authority.
- **Calling review-only output verified:** collapses distinct evidence states.
- **Hardcoded bot identity:** breaks attribution when the configured App changes.
- **Inspector chat that implicitly starts repair:** hides a state-changing action
  inside a read experience.

