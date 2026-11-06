# Reproducible demo

This walkthrough demonstrates the product without touching GitHub or the
development database used by the automated suites. It uses the normal local
services and the harmless configured fixture.

## 1. Prepare once

```bash
pnpm install
cp .env.example .env
```

Edit the new `.env` and set a unique `GITHUB_WEBHOOK_SECRET` of at least 16
characters plus a separate `CONTROL_API_TOKEN` of at least 32 characters. Keep
the safe defaults:

```dotenv
AUTHORIZATION_MODE=development-allow-all
REPOSITORY_SOURCE_MODE=local
LOCAL_REPOSITORY_PATH=fixtures/sandbox/passing-node
AGENT_MODEL_PROVIDER=disabled
AGENT_ALLOWED_REPOSITORIES=local/devsentinel-demo
GITHUB_DELIVERY_MODE=dry-run
INSPECTOR_MODEL_PROVIDER=disabled
```

Do not replace an existing `.env`; add only missing settings.

## 2. Start the complete system

```bash
docker compose up -d --wait postgres redis
pnpm db:migrate
pnpm build
pnpm dev
```

Leave `pnpm dev` running. In another terminal, confirm
`http://127.0.0.1:3001/health`, then open
`http://127.0.0.1:3001/dashboard`. Enter the control token. Readiness should show
the database ready, local source, model disabled, inspector fallback, and dry-run
delivery.

## 3. Trigger an authenticated TEST run

```bash
pnpm demo:trigger TEST
```

The helper builds a realistic `issue_comment` payload, signs the exact bytes
with the configured webhook secret, sends it only to loopback by default, and
prints the accepted run ID. It never prints the secret.

In the dashboard:

1. Search for “Local DevSentinel evidence demo”.
2. Open the run and watch the ordered authorization, snapshot, install, and test
   phases update through authenticated SSE.
3. Inspect the sealed task brief and approved `src` scope.
4. Confirm baseline install/test commands, exits, durations, bounded logs, and
   captured revision are persisted.
5. Ask “Why did this fail?” or “What should I do next?” The fallback answer must
   cite the saved run evidence and must not start another run.
6. Confirm the delivery card says dry-run and contains no GitHub PR claim.

The passing fixture should end as a successful TEST report. A different outcome
is evidence to diagnose, not something the demo should hide.

## 4. Exercise failure and recovery safely

Change only `LOCAL_REPOSITORY_PATH` to
`fixtures/sandbox/failing-node`, restart `pnpm dev`, and run a new
`pnpm demo:trigger TEST`. It should record a genuine test failure. Use the
dashboard to inspect logs and classification. The retry/cancel/scope controls
must show an explicit confirmation before their POST. Do not confirm an action
unless you intend to change that run.

For the automated timeout/cleanup proof, use the disposable suite:

```bash
pnpm test:sandbox
```

It proves pass, failure, forced timeout, bounded capture, and managed-container
cleanup without altering normal workflow data.

## 5. Optional model dry-run

This step can incur provider cost and is not part of the zero-credential demo.
Only after intentional activation, set:

```dotenv
LOCAL_REPOSITORY_PATH=fixtures/sandbox/repair-node
AGENT_ALLOWED_REPOSITORIES=local/devsentinel-demo
AGENT_MODEL_PROVIDER=openai
OPENAI_API_KEY=<server-side key>
OPENAI_MODEL=<supported model>
GITHUB_DELIVERY_MODE=dry-run
```

Restart and run:

```bash
pnpm demo:trigger FIX
```

The fixture's existing test reproduces its quantity bug. Review the saved plan,
tool trace, source-only patch, baseline/candidate comparison, criteria evidence,
actual/unknown usage, configured-rate estimate if enabled, and dry-run report.
A passing run still creates no PR.

Those accounting details are private operator data. If you later enable GitHub
delivery, the public comment and draft PR show the review-relevant change and
checks but omit model/tool usage and estimated cost.

## 6. Optional real GitHub dry-run, then delivery

Follow [GO-LIVE.md](GO-LIVE.md). First use GitHub App authorization/source with
`GITHUB_DELIVERY_MODE=dry-run` on one allowlisted playground issue. Confirm the
captured SHA, current permission rechecks, issue scope, and evidence.

Changing to `github-app` authorizes draft-PR/Check/comment writes. This is an
external action and should be done only with explicit operator intent. The App
must have installation-approved Metadata read and Contents, Issues, Pull
requests, and Checks write. DevSentinel never merges.

## 7. Automated release proof

```bash
pnpm build
pnpm test
pnpm test:evaluation
pnpm test:integration
pnpm test:browser
```

The integration/browser commands use disposable services. The browser journey
authenticates, opens real seeded run evidence, uses the inspector, checks that
the token appears in neither URL nor browser storage/resource URLs, verifies
desktop/mobile responsiveness and horizontal overflow, and fails on runtime
exceptions. Screenshots are test artifacts, not substitutes for assertions.

Offline evaluation uses deterministic doubles. Run
`pnpm test:evaluation:live` only when deliberately approving paid live-provider
use. Do not describe mocked/dry-run evidence as live GitHub publication.
