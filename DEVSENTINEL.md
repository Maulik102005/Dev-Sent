# DevSentinel repository guidance

Version: 1

This repository is the DevSentinel service itself. Repairs must remain scoped to
the triggering issue and preserve the durable-workflow invariants documented in
`docs/architecture.md`.

- PostgreSQL is workflow truth; BullMQ provides retry timing, not durable state.
- Keep GitHub credentials and model credentials inside trusted adapters.
- Do not execute repository-selected host commands. Test execution must use a
  recognized lockfile and the sandbox-owned package-test profile.
- Migrations are additive. Preserve historical runs, unknown usage, and delivery
  reconciliation data.
- Source changes need focused unit coverage plus the relevant full suite.
- A passing test is evidence; reports must not present it as proof of semantic
  correctness or successful publication.
