# Go-live checklist

Use this only after the local release proof is green. Start in dry-run mode on
one allowlisted playground. Do not expose the local dashboard publicly or enable
paid/model/GitHub writes merely to complete a checklist.

## 1. Protect existing state

Stop foreground API/dispatcher/worker processes with Ctrl+C. Leave PostgreSQL
and Redis running. Back up any valuable database before upgrading. Do not copy
`.env.example` over an existing `.env`, rotate working credentials without a
reason, reset workflow counters, or run `docker compose down -v`.

Inspect the migration journal, then apply the additive schema:

```bash
pnpm db:migrate
```

Current migrations run through `0008_parallel_quasar.sql`. The automated upgrade
test starts at migration 0005, inserts a historical run with unknown model usage,
applies current migrations twice, and verifies preservation. Historical data
that older code never stored cannot be reconstructed.

## 2. Prove the build on disposable services

```bash
pnpm build
pnpm test
pnpm test:evaluation
pnpm test:integration
pnpm test:browser
```

If this Linux host cannot forward Docker bridge ports:

```bash
DEVSENTINEL_TEST_NETWORK=host pnpm test:integration
DEVSENTINEL_TEST_NETWORK=host pnpm test:browser
```

These commands create separate PostgreSQL/Redis containers on random loopback
ports and remove only those containers. They do not load development `.env` or
truncate development tables. The browser test uses real Fastify/PostgreSQL
evidence and headless Chrome. The offline evaluation and repair provider used by
integration tests are deterministic doubles, not live-model proof.

Do not run `pnpm test:evaluation:live` without deliberately approving provider
cost and valid credentials.

## 3. Configure GitHub read/dry-run mode

Keep secrets server-side:

```dotenv
AUTHORIZATION_MODE=github-app
REPOSITORY_SOURCE_MODE=github-app
GITHUB_APP_ID=<configured App id>
GITHUB_APP_PRIVATE_KEY_PATH=.secrets/devsentinel.private-key.pem
GITHUB_API_URL=https://api.github.com
GITHUB_API_VERSION=2026-03-10
GITHUB_TEST_MINIMUM_PERMISSION=write
GITHUB_FIX_MINIMUM_PERMISSION=write

AGENT_ALLOWED_REPOSITORIES=owner/playground
AGENT_MODEL_PROVIDER=openai
OPENAI_API_KEY=<server-side key>
OPENAI_MODEL=<supported Responses API model>
GITHUB_DELIVERY_MODE=dry-run

CONTROL_API_TOKEN=<separate random token of at least 32 characters>
INSPECTOR_MODEL_PROVIDER=disabled
```

Use a model supported by the account and current Responses API contract. The
code does not hardcode one. Keep the inspector on deterministic fallback until
repair behavior is understood; it can be enabled separately with
`INSPECTOR_MODEL_PROVIDER=openai` and `INSPECTOR_MODEL`.

Generate control/webhook secrets outside source control. Do not reuse them,
paste them into issues, or place the App PEM in `.env`.

The App installation needs Metadata read, Issues read for trigger context,
Contents read for snapshot capture, and the configured actor permission.
Confirm the App is installed on the exact repository and the webhook sends
`issues` plus `issue_comment` events to `/webhooks/github`.

## 4. Start one supported path

```bash
docker compose up -d --wait postgres redis
pnpm db:migrate
pnpm build
pnpm dev
```

Open `http://127.0.0.1:3001/dashboard`, authenticate, and check readiness. Confirm
GitHub App authorization/source, model configured, dry-run delivery, the
allowlist count, database ready, and no unexplained dead letter.

If using Smee or another relay, forward only to
`http://127.0.0.1:3001/webhooks/github`. Do not put the control token in that
URL.

## 5. Run a dry-run issue

Create a narrowly scoped playground issue, then comment:

```text
/devsentinel fix
Outcome: <one issue-specific result>
Acceptance: <observable requested behavior>
Constraint: <behavior that must be preserved>
Scope: src/specific-file.js
```

Observe:

- actor permission was checked;
- task brief contains the full command and source provenance;
- target SHA and guidance hash were sealed;
- baseline actually reproduced the issue, or the run honestly stopped;
- saved plan and tool trace stay inside scope;
- targeted and required full-suite executions are recorded;
- criteria are shown as **Backed by saved checks** only when they cite passing
  execution records;
- unrelated/required red checks block delivery;
- attempts and reserved versus actual/unknown usage survive restart/retry;
- dry-run report makes no PR claim.

If intent is unclear, answer only the exact saved question with
`/devsentinel continue <run-id> <answer>` as an authorized actor before its
deadline. Confirm counters do not reset.

For a green baseline, do not enable test generation casually. The operator flag
and captured repository config must both allow it; review the frozen test and
confirm recorded failure on original source and success after the source patch,
plus a passing unweakened full suite.

## 6. Enable external delivery deliberately

Only after the dry-run evidence is satisfactory, grant installation-approved
Contents, Issues, Pull requests, and Checks write (Metadata remains read), then
set:

```dotenv
GITHUB_DELIVERY_MODE=github-app
```

Restart and create a new, narrowly scoped run. The system should create a stable
`devsentinel/run-<uuid>` branch, App-authored single-parent commit, draft PR,
Check, and one reconciled App-owned issue comment. It never pushes the default
branch, force-updates a branch, or merges.

Verify:

- author and committer resolve from the configured App bot;
- the tested base still equals the default branch before publication;
- the commit tree exactly matches the saved eligible patch;
- a lost response can be retried without a duplicate PR/comment/Check;
- revoking actor/App permission blocks the next gate;
- artifact URLs are saved only after reconciliation.

A run remaining in `PUBLISHING` is not a published success. Restore the precise
permission/connectivity problem and use authenticated retry so completed repair
work is not repurchased.

## 7. Operational readiness

- Keep API/control interfaces on loopback or behind a trusted authenticated
  reverse proxy.
- Restrict App installation to approved repositories and keep the model allowlist
  equally narrow.
- Apply provider-side spend limits in addition to application reservations.
- Alert on `/ops/readiness` dead letters, pending outbox age, and terminal
  classifications; scrape protected `/ops/metrics` from a trusted network.
- Define PostgreSQL backup/restore and evidence retention.
- Review Docker disk use and ensure untrusted containers never receive the Docker
  socket.
- Document credential rotation and incident ownership.
- Preserve the explicit distinction between dry-run, execution-eligible patch,
  successfully published draft PR, and merged code.

## Current verification boundary

The final local release report records the exact checks run for this code. Older
project history includes live model/dry-run and live draft-PR exercises, but
those predate this complete issue-scoped agent contract. Unless a new external
run is intentionally authorized, treat current feature publication as locally
and mock-provider verified—not newly live-provider/GitHub verified.
