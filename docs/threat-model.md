# Threat model

## Scope

This threat model covers the single-operator local MVP: a trusted API,
dispatcher, worker, PostgreSQL/Redis services, local Docker daemon, optional
OpenAI provider, and an installed GitHub App. It does not claim safety for
hostile public tenants or arbitrary languages.

Protected assets are GitHub/model/control credentials, repository confidentiality
and integrity, operator authority, workflow/evidence integrity, host availability,
and the correctness of GitHub publication labels.

## Trust boundaries and controls

| Threat | Implemented control | Residual risk |
| --- | --- | --- |
| Forged or replayed webhook | HMAC-SHA256 over raw bytes before JSON parse; bounded body; unique delivery ID transaction. | A compromised webhook secret can create signed requests until rotated. |
| Unauthorized actor | Repository-scoped App token and configured minimum permission; rechecks before costly repair and publish. | Permission can change during an in-flight external request. |
| Prompt/repository injection | Versioned platform rules; repository/comments/logs marked evidence; narrow phase tools; application schemas and path checks. | A semantically harmful source edit can still fit policy and needs review. |
| Scope escalation | Immutable task brief, approved/excluded paths, explicit durable scope approval, source-only patch gate. | Broadly written authorized scope is still broad; operator judgment matters. |
| Secret exfiltration | Credentials stay in adapters; no shell/URL/database/GitHub model tools; protected-file filtering and content redaction; test network disabled. | Pattern detection is best-effort; install egress exists; source may contain an unrecognized secret. |
| Host compromise by tests | Non-root Docker user, read-only root, dropped capabilities, no-new-privileges, seccomp, resource/deadline limits, no Docker socket, test network none. | Docker shares the host kernel; the worker controls the daemon. |
| Repository-selected command execution | Exactly one recognized lockfile; application-owned install/test argv; only `package-test` profiles; no shell concatenation. | Package install necessarily executes package-manager code, though lifecycle scripts are disabled. |
| Budget bypass after crash/pause | PostgreSQL reservations before model/tool work; fenced leases; uncertain work not refunded; clarification reuses workflow. | Conservative reservations can over-count and block useful work. |
| Test weakening | Existing test paths protected; fingerprint checks; separately gated new reproducer frozen and hashed; fail-before/pass-after/full-suite proof. | Test coverage can still be incomplete or encode a mistaken requirement. |
| False “verified” claim | Acceptance support is computed from execution records; all required checks must pass; publication requires exact eligible attempt. | Passing checks do not prove semantic correctness. |
| GitHub drift/duplication | Captured SHA, default-branch recheck, deterministic branch, commit parent/tree matching, App-owned pagination and run markers. | Cancellation cannot undo a side effect already accepted by GitHub. |
| Browser credential leakage | Bearer header, in-memory token, no URL token, no-store, CSP, no-referrer, cross-origin POST rejection, text-only rendering. | Malware/extensions on the operator machine remain outside this app's control. |
| Inspector-induced action | Authenticated evidence access, separate durable budget, allowed citation IDs, read-only endpoint and deterministic fallback. | A user may choose to act on incomplete advice; explicit mutation confirmation is still required. |
| Data loss on upgrade | Additive migrations; disposable fresh/upgrade integration proofs; operator backup instructions. | Tests do not replace backups or disaster-recovery exercises. |
| Denial of service | Request/output/context/tool/process bounds, queue retries, concurrency limits, Docker limits, pagination. | A local operator or compromised App can still consume configured resources. |

## Authority hierarchy

1. Application-enforced global safety and budget rules.
2. Explicit operator/GitHub actor authorization and sealed task scope.
3. Captured maintainer repository configuration and conventions.
4. Issue discussion, source text, logs, and model/tool output as untrusted
   evidence.

A lower level cannot override a higher one. `.devsentinel.json` has no fields for
host commands, credentials, model limits, delivery permission, or sandbox limits.

## Credential flow

- The webhook secret is used only by the API signature verifier.
- The App private key signs App authentication in the worker; short-lived
  installation tokens are repository/permission scoped.
- The model key is used only in server-side repair/inspector adapters.
- The control token is compared using fixed-length SHA-256 digests and sent by
  the dashboard only in `Authorization`.
- Credentials are not persisted in workflow tables, queued payloads, Docker
  containers, model prompts, URL query strings, or public reports.

## Publication claim boundary

`PUBLISHING` means execution evidence made a patch eligible, not that publication
succeeded. `SUCCEEDED` plus `delivery.mode=github-app` and saved artifact data
means delivery was reconciled. `SUCCEEDED` plus `dry-run` means no GitHub write.
No status means merge: DevSentinel always creates a draft and never merges.

## Deployment exclusions

Before public multi-tenant deployment, add tenant identity/authorization,
per-tenant model and compute quotas, VM-grade sandboxing on dedicated nodes,
registry-only egress with allowlisted immutable artifacts, network segmentation,
secret scanning designed for the deployment, encrypted backup/restore drills,
retention/deletion policy, audit export, abuse controls, and production
observability. Keep the Docker socket and local operations API inaccessible from
untrusted networks.

