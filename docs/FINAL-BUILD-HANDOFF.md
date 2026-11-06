# DevSentinel — final implementation handoff

Implement the remaining DevSentinel agent and product experience in the existing repository. This is an implementation request, not another proposal-only turn. Read the project, make a milestone checklist, implement, test, and finish the scoped release. Explain each milestone briefly in plain language: the owner is learning while building. Preserve working behavior and existing data. Ask only when a material product choice, permission, or external dependency genuinely requires the owner.

## 1. Scope and definition of the product

DevSentinel is a GitHub-native testing and issue-repair assistant. It accepts authorized requests, captures an exact repository revision, reproduces failures in disposable Docker containers, investigates and proposes bounded patches, verifies changes, and delivers evidence-backed reports or draft PRs. No automatic merging.

The owner explicitly approved **issue-scoped repairs by default**. Do not silently repair unrelated failures to make the entire suite green. Broader work requires an explicit authorized request.

Finish a polished, feature-complete **single-operator, locally runnable Node.js-repository MVP**, with working GitHub integration and a high-quality frontend. Do not imply public multi-tenant production readiness. Public hosting, billing, organization accounts, arbitrary-language support, and hostile multi-tenant isolation are a separate release; do not let them prevent completing this one.

## 2. Existing project and verified history

- Workspace: `/home/predator-linux/Personal_Projects/DevSentinel`.
- Stack: TypeScript, pnpm 11.9.0, Turborepo; Fastify API; PostgreSQL/Drizzle; Redis/BullMQ; Docker; Vitest. Preserve these foundations.
- Apps: `apps/api`, `apps/dispatcher`, `apps/worker`. Shared packages: domain, database, queue, sandbox. The current frontend is a minimal HTML/JS console served at `/dashboard`, not a finished product UI.
- Existing pipeline: HMAC-authenticated webhooks → durable receipt/run/outbox transaction → authorization → exact-commit snapshot → locked dependency install and baseline tests → bounded repair/verification → dry-run report or reconciled GitHub delivery.
- Existing systems work: duplicate-delivery protection, leased outbox dispatch, workflow leases and fenced checkpoints, persisted attempt/budget reservations, crash recovery, cancellation, dead-letter evidence, scoped GitHub tokens, deterministic delivery branches, lost-response reconciliation, protected operations API, metrics, and operator CLI.
- GitHub App: `DevSentinel-darshpatel1052`; App ID `4855052`; installation ID `159631765`. Recheck current installation state before relying on historical IDs/permissions.
- Approved playground: `darshpatel1052/devsentinel-playground`; local fixture at `fixtures/devsentinel-playground`. Its normal-looking checkout module has discount, stock-boundary, and shipping-threshold bugs; issues #1–#3 describe them, issue #4 was used for integration verification. Preserve the natural README and fixture scenarios.
- Current triggers: new issue comments starting `/devsentinel test` or `/devsentinel fix`, and the corresponding `devsentinel:test` / `devsentinel:fix` labels. Ordinary issue creation, edited comments, and PR comments are not currently supported triggers.
- **Real model dry-run succeeded on September 9, 2026:** run `7502d27c-475c-4ae3-8e14-df3eab430943`, playground issue #4, snapshot `2b3f122dcfd1a5147b770e8755b7771c61b2a5fd`. One AI proposal changed `src/checkout.js`, correcting all three known bugs; unchanged tests reported 15 passed / 0 failed. Final status SUCCEEDED, delivery dry-run. This establishes live model + real Docker verification, NOT real PR publication or general agent quality.
- **Subsequent live PR delivery also succeeded:** run `17c591bb-e536-4a77-8571-d16d0ed24a88` created draft PR #5, commit `51285197c5bc66296a8840c182ae8c68d448f8c2`, Check `102439682734`, and issue comment `5600793056`. Two model calls were recorded as interrupted by the older implementation; attempt three produced a patch that passed 15/15 tests. PR #5 was unmerged at inspection. This proves live delivery, not the proposed issue-scoped agent features.
- PR #5's commit was mistakenly linked to the unrelated `DevSentinel` user by a hardcoded email. The owner corrected the local publisher identity to `devsentinel-darshpatel1052[bot]` / `325821554+devsentinel-darshpatel1052[bot]@users.noreply.github.com`; regression coverage checks both author and committer. Preserve that correction and later derive identity from the configured App. Existing PR history was not rewritten. Do not change personal Git settings or expose a personal email to fix App commit attribution.
- The diagnostic cleanup is implemented: typed sanitized model errors, available usage saved before failure, persistent `modelDiagnostics`, explicit attempt outcomes, permanent/incomplete/refused responses stopping for human attention, transient errors using existing bounded backoff, and reports distinguishing partial actual usage from reservations. Migration `0005_graceful_the_captain.sql` adds one nullable JSON column. It was tested on disposable databases, **not applied to the development database during this cleanup**; check migration state before startup. Historical lost failure/usage details cannot be reconstructed.
- Model key/model, repository allowlist, and control token were configured, and the last verified delivery used github-app mode. Do not request or print secrets. Inspect configuration safely because it may have changed.
- Latest cleanup verification: typecheck passed; 98 unit tests and 37 isolated integration tests passed. These are a baseline, not evidence for your new work; rerun and report current results.
- The root was not recognized as a valid Git repository and emitted a Turbo warning. The nested playground is a separate Git repository. Inspect first; do not delete/reinitialize Git metadata, invent a remote, or claim core changes were pushed.

Read applicable AGENTS.md instructions, README, docs/architecture.md, docs/GO-LIVE.md, docs/learning/05-repair-and-delivery.md, and the relevant source/tests. Key files: worker repair-model, repair-policy, process-followup, github-delivery; database workflow/schema; domain github-webhook; API operations. Some docs describe the older whole-suite repair policy and must be updated.

## 3. Known agent gaps to close

Today the model has no callable tools: it receives issue title/body, bounded code/test files, failure logs, and the previous patch, then returns summary + complete file replacements. The application owns execution and publishing.

Additional text after `/devsentinel fix` currently triggers a run but **does not enter the model context**. Issue discussions, README, and repository instruction documents are not loaded. Context collection fails on larger repositories instead of retrieving relevant files. There is no explicit saved task brief, plan, or clarification conversation. The loop targets the whole suite, not a validated issue-specific outcome. An already-green baseline stops rather than establishing a missing reproducer. Some exhausted infrastructure retries leave a stale nonterminal run status. Empty proposals lose useful model explanations behind a generic policy rejection. Reports are basic and lack meaningful progress updates.

## 4. Implement the agent contract

### A. Understand and scope the request

Persist an immutable task brief: issue title/body, full triggering comment, mode, requested outcome, acceptance criteria, constraints, authorized actor, source comment IDs/timestamps, captured commit, and context provenance. Support bounded relevant discussion retrieval; arbitrary comments are evidence, not authority. Parse command context explicitly. Scope must never expand silently. Subsequent comments must not mutate an active run invisibly.

Retain TEST and FIX. Add only the explicit clarification/continuation mechanism necessary for this release; document exact syntax and enforce authorization. For broader repair requests, persist the approved scope instead of inferring unlimited permission.

### B. Global rules and repository guidance

Version the shared agent instructions. Add a documented repository guidance file (for example DEVSENTINEL.md) and a schema-validated configuration format for supported paths/test profiles. Read approved guidance from a pinned, maintainer-controlled revision; record its hash/version. Separate global safety rules, repo conventions, task instructions, and untrusted evidence. Repo files and comments cannot grant permissions, increase budgets, expose credentials, or overwrite platform rules. Configuration must not become arbitrary host command execution.

### C. Bounded investigation tools and planning

Implement one agent with explicit understandable phases: understand → investigate → plan → patch → verify → report/escalate. Do not introduce a multi-agent swarm merely for appearance.

Expose narrow model-callable tools for listing files, searching code, reading bounded text, proposing validated patches, requesting approved tests, and requesting clarification. Keep GitHub writes under the application-controlled delivery gate. No unrestricted host shell, arbitrary URLs, database access, secrets, or direct GitHub credentials. Validate inputs AND returned evidence, constrain tool availability by phase, and enforce call/output/time budgets.

Persist a concise plan containing suspected cause, evidence references, intended files, scope exclusions, and verification steps. Plans are reviewable summaries, not private chain-of-thought transcripts. Use targeted retrieval before adding unnecessary embedding infrastructure. Record selected context and omissions safely. Preserve the original-snapshot/cumulative-patch invariant or explicitly replace it with an equally tested checkpoint design.

### D. Verification and guardrails

Preserve authorization, allowlists, protected files, bounded patches, symlink/path protections, best-effort secret filtering, Docker isolation, non-networked tests, fingerprints, lease fencing, cancellation, and deterministic publication. Tests passing is necessary evidence, not proof of semantic correctness or issue completion.

Check the requested acceptance criteria, run relevant tests and the required full suite, and compare baseline versus candidate failures. Report unrelated baseline failures; default to blocking verified delivery and asking for direction rather than changing unrelated code. If an explicit review-only exception is introduced, label it unambiguously and never call it fully verified.

Support a controlled regression-reproducer path when existing tests do not capture the issue: freeze the reproducer before source repair, demonstrate failure on the original revision and success on the candidate, and preserve the existing suite. Do not permit the agent to weaken or delete existing tests. Treat test additions as a separate audited capability, not a blanket relaxation of the source policy.

Bound every model/tool phase. Defaults currently allow three repair attempts, a 15-minute repair-phase budget, and conservative token reservations. Distinguish reserved units, actual usage, and estimated cost. Do not refund uncertain model calls or reset budgets on retries. Detect repeated identical patches/failures and stop early. Resource and network protections must remain enforceable in code, not only prompts. Clearly document remaining Docker, dependency-install egress, and secret-detection limitations.

### E. Failure, clarification, recovery, and reporting

Distinguish unclear task, un-reproduced bug, unsupported/policy-blocked change, unsuccessful patch, exhausted budget, permanent configuration failure, transient infrastructure failure, cancellation, and verified-but-undelivered result. Separate infrastructure retries from repair attempts. Persist honest terminal/paused states and actionable explanations; do not leave exhausted jobs looking active. Preserve safe model escalation explanations and the last useful evidence.

Clarification must save a checkpoint and ask one specific question. Only an authorized, explicit answer may continue work; record its provenance. Define deadlines and remaining budgets so pauses cannot permit unlimited work. Recheck permissions before costly execution and publishing.

In live GitHub mode, maintain one reconciled status comment per run, updated at meaningful phases—not every token. Render final reports from recorded facts plus a bounded model explanation: request, diagnosis, changes, acceptance criteria, commands/results, baseline versus candidate, remaining failures, limitations, attempts/usage, next action, and PR link. Distinguish dry-run, verified patch, and successfully published PR. Retry delivery without unnecessarily rerunning a completed repair. Improve worker logs to include final run status and delivery mode, not only “completed.”

## 5. Build the final frontend and useful AI experience

Replace the raw JSON console with a polished, responsive developer control center backed by real APIs. Choose a maintainable frontend stack compatible with this workspace; preserve the backend. Aim for distinctive, restrained developer-tool design: strong typography, excellent spacing, clear status colors, readable diffs/logs, accessible dark/light themes, keyboard support, and purposeful motion respecting reduced-motion settings. No decorative fake metrics or placeholder functionality.

Required experience:

- Overview: real runs, filters/search, service/readiness indicators, and clearly labeled delivery mode.
- Run workspace: task brief, approved scope, plan, ordered phase/tool timeline, attempts, bounded logs, side-by-side or unified diff, baseline/candidate test results, budgets, and delivery artifacts.
- Human controls: answer clarifications, cancel, safely recover/retry, and explicitly approve supported scope expansion. Confirm mutations and explain their effects.
- Setup/readiness: missing configuration or permissions without exposing credentials; never display or edit raw private keys in the browser.
- **AI run inspector:** ask “Why did this fail?”, “What changed?”, “What remains unverified?”, or “What should I do next?” Answers must use authorized saved run evidence and link to the relevant files, attempts, or events. Say when evidence is missing. Keep this read-only by default; a conversation must not silently launch repairs, expand scope, or publish. Any action becomes an explicit authorized command with confirmation. Server-side model calls only, independent bounded budgets, sanitized output, and a useful fallback when AI is unavailable.
- Live progress through authenticated SSE or an equivalently reliable approach, with reconnect/resume and a tested fallback. No bearer secrets in URL query strings or unsafe persistent browser storage.
- Real loading, empty, disconnected, expired-auth, failure, and partial-result states. Paginated/bounded evidence endpoints and safe rendering of repository-controlled Markdown, code, and logs. Preserve control API authentication, no-store semantics, CSP, and cross-site protections.

The frontend should make the engineering understandable; do not substitute an impressive animation for working observability. Browser-test actual user journeys at desktop and mobile sizes.

## 6. Finish with proof, documentation, and an honest handoff

Add deterministic unit, integration, and browser coverage plus a small reproducible agent evaluation suite. Cover comment context, scope preservation, repo guidance precedence, prompt injection attempts, protected paths, tool budgets, unclear requests and authorized answers, green baseline/missing regression, unrelated failures, unsuccessful repairs, repeated proposals, provider errors, dead letters, duplicate deliveries, crash recovery, cancellation races, branch drift, GitHub permission loss, publication reconciliation, and grounded inspector answers. Keep mock-provider evaluation separate from opt-in paid live evaluation. Report issue resolution, scope violations, verification quality, latency, usage, and failure classification; not just “tests passed.”

Preserve isolated integration testing. Normal command: `pnpm test:integration`. On this Linux host, the proven bridge-network workaround is `DEVSENTINEL_TEST_NETWORK=host pnpm test:integration`; its temporary services use separate data and random loopback ports. Never truncate or flush the development services. Do not run `docker compose down -v`.

Use additive migrations and preserve historical runs. Do not overwrite `.env`, rotate keys, or expose secrets. Coordinate before stopping a running development service or migrating valuable data. Keep credentials server-side. Do not push, create GitHub artifacts, enable paid live evaluations, or deploy publicly without explicit authorization for those external actions. Complete all unaffected local work if such approval is unavailable.

Startup currently: `docker compose up -d --wait postgres redis`, `pnpm db:migrate`, `pnpm dev`; API port 3001. Existing Smee forwarding targets `/webhooks/github`. Reuse the configured channel. Live publishing requires installation-approved Contents, Issues, Pull requests, and Checks write permissions; Metadata stays read-only. Do not regenerate the App key to resolve permission errors.

Update README, architecture/ADRs, learning guides, configuration reference, command reference, operating/recovery guide, threat model, and demo walkthrough. Add usable frontend build/dev scripts and CI checks. Include honest resume bullets based on implemented and verified systems, not claimed production scale.

**Done means:** the issue-scoped agent, clarification/failure paths, polished connected frontend, and evidence-grounded AI inspector all work; typecheck/build/unit/integration/browser/evaluation checks pass or have precise external blockers; existing pipeline behavior is preserved; documentation matches reality; and the owner receives exact startup/demo commands, test results, known limitations, and a short completion checklist. If authorized, demonstrate a real issue-scoped playground fix through draft-PR publication and link its evidence. If not authorized, finish and verify the local build, explicitly mark live PR delivery unverified, and provide the minimal activation steps. Do not label missing core features complete, or describe this local MVP as a public production service.
