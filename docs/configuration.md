# Configuration reference

DevSentinel reads the root `.env` in each service process. Start from
`.env.example` only for a fresh setup; never overwrite an existing environment
file. Keep the GitHub App PEM under ignored `.secrets/` storage.

## Safe local defaults

The example uses:

- `AUTHORIZATION_MODE=development-allow-all`
- `REPOSITORY_SOURCE_MODE=local`
- `AGENT_MODEL_PROVIDER=disabled`
- `GITHUB_DELIVERY_MODE=dry-run`
- `INSPECTOR_MODEL_PROVIDER=disabled`

This runs the real queue/database/Docker pipeline against
`LOCAL_REPOSITORY_PATH`, while the repair model is disabled and the inspector
uses its deterministic evidence fallback. Development allow-all is not suitable
for a GitHub-connected deployment.

## Core service settings

| Variable | Default/example | Meaning |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `3001` | API listener. Keep loopback unless a trusted reverse proxy supplies transport and operator authentication. |
| `DATABASE_URL` | local PostgreSQL | Durable workflow/evidence store. |
| `REDIS_URL` | local Redis | BullMQ delivery and retry timing. |
| `GITHUB_WEBHOOK_SECRET` | required, 16+ chars | Verifies the exact raw webhook body. |
| `CONTROL_API_TOKEN` | optional, 32+ chars | Enables `/ops`. It must differ from the webhook secret. |
| `LOG_LEVEL` | `info` | Structured service log level. |

## GitHub and repository source

Live GitHub operation requires both:

```dotenv
AUTHORIZATION_MODE=github-app
REPOSITORY_SOURCE_MODE=github-app
GITHUB_APP_ID=<configured app id>
GITHUB_APP_PRIVATE_KEY_PATH=.secrets/devsentinel.private-key.pem
GITHUB_API_URL=https://api.github.com
GITHUB_API_VERSION=2026-03-10
```

The worker refuses an HTTP GitHub API URL and refuses GitHub repository source
without App authorization. `GITHUB_TEST_MINIMUM_PERMISSION` and
`GITHUB_FIX_MINIMUM_PERMISSION` default to `write`. Installation tokens are
requested for one repository and only the permissions needed at that phase.

`GITHUB_DELIVERY_MODE=dry-run` records the report locally and performs no
GitHub write. `github-app` delivery additionally needs installation-approved
Metadata read plus Contents, Issues, Pull requests, and Checks write.

## Repair model and durable budgets

```dotenv
AGENT_ALLOWED_REPOSITORIES=owner/repository
AGENT_MODEL_PROVIDER=openai
OPENAI_API_KEY=<server-side key>
OPENAI_MODEL=<Responses API model id>
AGENT_MAX_ATTEMPTS=3
AGENT_MAX_TOKENS=200000
AGENT_MAX_OUTPUT_TOKENS=4096
AGENT_MAX_MODEL_TURNS=4
AGENT_MAX_TOOL_CALLS=24
AGENT_MAX_TOOL_OUTPUT_KB=16
AGENT_MAX_DURATION_MS=900000
AGENT_MODEL_TIMEOUT_MS=120000
AGENT_CLARIFICATION_TTL_MS=172800000
AGENT_ALLOW_REGRESSION_TESTS=false
```

The allowlist is comma-separated and exact. A repository cannot opt itself into
model processing. Attempts, token units, tool calls/output bytes, and the repair
deadline are application-validated and reserved in PostgreSQL before uncertain
work. Repository guidance cannot change them. Clarification and process retries
continue the existing counters; a bounded clarification pause preserves only
the unused active repair time and never creates a fresh allowance.

Optional `AGENT_INPUT_COST_MICROUSD_PER_MILLION` and
`AGENT_OUTPUT_COST_MICROUSD_PER_MILLION` turn known token usage into a
configured-rate estimate. One USD is 1,000,000 micro-USD. This is deliberately
labelled an estimate, never a provider invoice; if either rate or usage is
unknown, the report says so.

Regression creation requires two independent gates:

1. `AGENT_ALLOW_REGRESSION_TESTS=true` in the operator environment.
2. `regressionTests.enabled=true` plus allowed directories in the captured
   repository's `.devsentinel.json`.

## Inspector

```dotenv
INSPECTOR_MODEL_PROVIDER=disabled
INSPECTOR_MAX_QUERIES=20
INSPECTOR_MAX_TOKENS=50000
INSPECTOR_MAX_OUTPUT_TOKENS=800
INSPECTOR_TIMEOUT_MS=30000
# INSPECTOR_MODEL=<small Responses API model>
```

The inspector has counters separate from repair budgets. With provider disabled
it still answers common questions from saved evidence. With `openai`, it uses
the server-side `OPENAI_API_KEY`; output citations are filtered to evidence IDs
that were actually supplied. Provider failure falls back to deterministic saved
evidence. Inspector responses never enqueue, patch, expand scope, or publish.

## Sandbox

`SANDBOX_DOCKER_IMAGE`, CPU, memory, PID, install/test deadline, and output
limits are parsed and bounded by the worker. `BASELINE_WORKER_CONCURRENCY`
defaults to one. The package manager and commands come from exactly one supported
lockfile; `.devsentinel.json` cannot provide a command string.

Install containers have registry network access with lifecycle scripts disabled.
Test containers use no network. Docker remains shared-kernel local isolation.

## Captured repository policy

The optional `.devsentinel.json` is strict JSON:

```json
{
  "version": 1,
  "guidance": { "path": "DEVSENTINEL.md", "version": "1" },
  "supportedSourcePaths": ["src", "lib"],
  "excludedPaths": ["src/generated"],
  "testProfiles": [
    { "name": "unit", "relevantPaths": ["src"], "runner": "package-test" }
  ],
  "regressionTests": {
    "enabled": false,
    "allowedPaths": ["test", "tests"]
  }
}
```

Unknown keys, unsafe paths, arbitrary runners, linked files, oversized guidance,
and secret-like guidance are rejected. `DEVSENTINEL.md` is convention-level
guidance only. Its version, content, and SHA-256 hash are captured with the task
brief at the pinned commit.
