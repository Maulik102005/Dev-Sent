# Milestone 3: real GitHub App authorization

## What the code now does

The worker can replace `development-allow-all` with this real flow:

```text
Verified webhook supplies installation ID, repository ID, and actor
                              |
                              v
GitHub App signs an app JWT and requests an installation token
  - token is limited to the one repository
  - authorization token asks only for metadata:read during this check
                              |
                              v
GET /repos/{owner}/{repo}/collaborators/{actor}/permission
                              |
                 +------------+------------+
                 |                         |
          write/admin                 read/none
                 |                         |
            PREPARING                   REJECTED
```

GitHub's official SDK creates, caches, and refreshes the short-lived
installation token. DevSentinel does not place that token in a BullMQ job,
PostgreSQL row, error message, or log field.

## Authentication versus authorization

These checks solve different problems:

- Webhook HMAC: **did GitHub send these exact bytes?**
- Installation token: **is this process acting as the installed GitHub App?**
- Collaborator permission: **may this particular actor request this run?**

A valid webhook is not enough to approve its actor. An issue can be opened or
commented on by someone who has no write access.

## Current permission policy

The secure default is `write` for both operations:

```text
TEST requires write
FIX  requires write
```

`admin` also passes. GitHub's base permission response maps `maintain` to
`write` and `triage` to `read`; the more specific role is retained in the
recorded explanation.

`TEST` still requires trust because dependency installation and test scripts
execute repository code and consume compute. It is not harmless simply because
it does not edit files.

The thresholds are configurable independently:

```dotenv
GITHUB_TEST_MINIMUM_PERMISSION=write
GITHUB_FIX_MINIMUM_PERMISSION=write
```

Do not lower test access to `read` for a public service until VM-grade
isolation, tenant quotas, and abuse controls exist. The current Docker provider
is a local/CI milestone, not that final boundary.

## Register a development GitHub App

Use a test repository you control. Do not begin with an important private
repository.

1. Open GitHub **Settings -> Developer settings -> GitHub Apps -> New GitHub
   App**.
2. Give it a unique name such as `DevSentinel <your-name> Dev`.
3. Use your repository or a placeholder page as the homepage URL.
4. Enable webhooks.
5. Generate a high-entropy webhook secret, for example:

   ```bash
   openssl rand -hex 32
   ```

6. Put the same value in GitHub's **Webhook secret** field and local
   `GITHUB_WEBHOOK_SECRET`.
7. Under repository permissions, select **Issues: Read-only** for triggers and
   **Contents: Read-only** so the baseline worker can resolve and download the
   exact commit. Metadata read access is available to the installation and is
   used by the collaborator endpoint.
8. Subscribe to **Issues** and **Issue comment** events.
9. For installation scope, choose **Only on this account** while developing.
10. Create the App and install it on **only the selected test repository**.

These read-only permissions are sufficient for this authorization/baseline
milestone. The delivery code now exists; enable its extra write permissions
only when following the [go-live checklist](../GO-LIVE.md).

## Store the private key safely

Generate and download a private key from the App settings page. Move it into
the ignored directory:

```bash
mkdir -p .secrets
mv /path/to/downloaded-key.pem .secrets/devsentinel.private-key.pem
chmod 600 .secrets/devsentinel.private-key.pem
```

`.secrets/` and `.env` are ignored by Git. The worker validates that the file is
a parseable private key before opening its database connection.

Never paste the PEM into an issue, commit, screenshot, log, or chat. If it is
exposed, revoke that key in the GitHub App settings and generate another.

## Configure the worker

Copy the example environment if needed, replace the development mode, and fill
in the App ID shown on the App settings page:

```dotenv
AUTHORIZATION_MODE=github-app
REPOSITORY_SOURCE_MODE=github-app
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=.secrets/devsentinel.private-key.pem
GITHUB_API_URL=https://api.github.com
GITHUB_API_VERSION=2026-03-10
GITHUB_TEST_MINIMUM_PERMISSION=write
GITHUB_FIX_MINIMUM_PERMISSION=write
```

The relative key path is resolved from the workspace root, even though the
worker process runs from `apps/worker`.

## Forward development webhooks

GitHub needs an HTTPS URL, while the API listens locally on port 3001. GitHub's
development documentation uses Smee as a temporary forwarding service.

1. Create a temporary channel at `https://smee.io`.
2. Put that channel URL in the GitHub App's **Webhook URL** field.
3. Start DevSentinel:

   ```bash
   docker compose up -d postgres redis
   pnpm db:migrate
   pnpm dev
   ```

4. In a second terminal, forward the channel to the real route:

   ```bash
   pnpm dlx smee-client@5.0.0 \
     --url YOUR_SMEE_CHANNEL_URL \
     --path /webhooks/github \
     --port 3001
   ```

Smee is development-only. Its channels are not an authenticated production
transport, so do not use it with sensitive payloads or as the deployed webhook
URL.

## Perform the first live test

1. Create an issue in the installed test repository.
2. Comment `/devsentinel test`, or create and apply `devsentinel:test`.
3. Confirm GitHub's App settings show a successful webhook delivery.
4. Confirm the API returns `202` for the first delivery.
5. Watch the dispatcher and worker logs.
6. Inspect the durable result:

   ```bash
   docker compose exec postgres psql -U devsentinel -d devsentinel \
     -c "select id, mode, status, actor_login, target_commit_sha, authorization_reason, status_reason from runs order by created_at desc limit 5;"
   ```

`PREPARING` is now a short-lived intermediate state. For a user with write or
admin access, a `TEST` run should finish as `SUCCEEDED` or `FAILED`; a `FIX` run
with a reproducible failure should reach `DIAGNOSING`. A read-only or unknown
user should still become `REJECTED`, with the required and actual base
permissions recorded in `authorization_reason`.

## Failure behavior

| GitHub result | DevSentinel behavior |
|---|---|
| `200`, permission meets threshold | `PREPARING` |
| `200`, permission below threshold | `REJECTED` |
| `404` | Treat as `none`; `REJECTED` |
| First `401` | Force-refresh installation token and retry once |
| Repeated `401`, `403`, `429`, or `5xx` | Throw; BullMQ retries, then marks `FAILED` after exhaustion |
| Malformed GitHub response | Throw; BullMQ retries, then marks `FAILED` after exhaustion |

Infrastructure errors never become accidental approval or `REJECTED`, because
a rate limit or GitHub outage says nothing about the actor's permission. After
all configured attempts fail, the run becomes `FAILED` with a token-redacted
reason instead of remaining stuck in `AUTHORIZING`.

## Read the code in this order

1. `apps/worker/src/env.ts` — configuration is a discriminated union, so GitHub
   mode cannot start without its required credentials.
2. `apps/worker/src/configured-authorizer.ts` — key loading and adapter wiring.
3. `apps/worker/src/github-app-authorizer.ts` — token scope, API request,
   permission policy, 401 refresh, and error behavior.
4. `apps/worker/src/github-app-authorizer.test.ts` — policy and HTTP boundary
   tests without secrets or internet access.
5. `apps/worker/src/authorization-pipeline.integration.test.ts` — the same
   policy driving a real PostgreSQL/Redis state transition.

## What remains after the live checkpoint

The disposable baseline is now implemented:

```text
PREPARING -> PROVISIONING -> BASELINING
```

It captures the exact commit, detects the supported project type, installs
locked dependencies, executes unchanged tests with resource/time/network
limits, and stores evidence. The next code milestone is the bounded agent loop:

```text
DIAGNOSING -> PATCHING -> VERIFYING
```

That loop must consume the recorded failing evidence, make a limited number of
changes, and prove the original failure turns green without regressing the full
suite.

## Official references

- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app)
- [Authenticating as an installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [Repository collaborator permission endpoint](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user)
- [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)
- [Testing webhooks locally](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/testing-webhooks)
