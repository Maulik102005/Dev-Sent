# Milestone 4: the disposable baseline sandbox

## What changed, in simple terms

Before this milestone, DevSentinel could safely answer one question:

> Is this GitHub user allowed to request work?

An allowed run stopped at `PREPARING`. It never downloaded or executed the
repository.

It can now answer a second question:

> On one recorded version of this repository, does its unchanged test suite
> pass, fail, or run forever?

Think of authorization as checking a mechanic's work order. This milestone
builds the locked garage, places one exact car inside it, limits the mechanic's
tools and time, records the diagnostic output, and empties the garage after the
job.

No model is involved yet. Establishing a trustworthy failing baseline before
asking AI to change code is intentional: without it, the agent cannot prove
that it reproduced or fixed anything.

## End-to-end flow

```text
Authorization succeeds
        |
        | same PostgreSQL transaction
        v
PREPARING + run.baseline.requested outbox row
        |
        v
Dispatcher -> stable BullMQ baseline job
        |
        v
Capture repository snapshot and record its identity
        |
        v
Detect exactly one lockfile and a test script
        |
        v
PROVISIONING
        |
        +--> install container: locked install, bounded, registry network
        |                       lifecycle scripts disabled
        |
        `--> test container: unchanged test script, bounded, no network
                     |
                     v
          PostgreSQL transaction stores:
          - final/next run state
          - image reference and command arguments
          - exit code and timeout flag
          - duration and bounded stdout/stderr
                     |
                     v
          remove temporary containers and snapshot
```

The API still returns quickly. A five-minute test does not hold a GitHub
webhook connection open.

## Why there is another outbox event

Authorization changes the run to `PREPARING` and creates
`run.baseline.requested` in one PostgreSQL transaction.

This prevents a classic dual-write bug:

1. save `PREPARING` in PostgreSQL;
2. crash before sending the Redis job;
3. leave a run that looks ready but will never execute.

With the outbox, the state and promise of future work either both commit or
both roll back. The dispatcher may publish more than once, so the BullMQ job ID
is derived from the durable outbox ID. This is an example of **at-least-once
delivery plus idempotent processing**, not a claim of magical exactly-once
execution.

## Repository identity: do not test a moving branch

`main` is a friendly name, but it can point to a different commit five seconds
later. A retry that resolves `main` again could test different code and combine
its logs with the original run.

The GitHub source adapter therefore:

1. requests a short-lived installation token scoped to one repository with
   `metadata:read` and `contents:read`;
2. resolves the requested branch/ref to a 40-character commit SHA;
3. downloads that commit's GitHub archive without putting the token in a Git
   command, URL, database row, queue job, or container;
4. enforces a 100 MiB archive limit;
5. extracts it into a new temporary directory;
6. records the SHA before executing anything.

If a retry receives content that does not match the recorded SHA, it fails
instead of silently changing the experiment.

Local learning mode copies a fixture and computes a stable 40-character tree
hash. That proves the same workflow without pretending the fixture hash is a
Git commit.

## Toolchain detection: policy chooses commands

DevSentinel currently supports Node.js repositories at the repository root.
It requires:

- a regular `package.json` file;
- a non-empty `scripts.test` entry;
- exactly one supported lockfile;
- a pinned `packageManager` field for pnpm and yarn.

The lockfile determines a fixed argument array:

| Lockfile | Install | Test |
|---|---|---|
| `package-lock.json` | `npm ci --ignore-scripts --no-audit --no-fund` | `npm test` |
| `pnpm-lock.yaml` | `corepack pnpm install --frozen-lockfile --ignore-scripts` | `corepack pnpm test` |
| `yarn.lock` | immutable/frozen install with build scripts skipped | `corepack yarn test` |

There is no `sh -c "${issueText}"`. Every argument is passed directly to the
Docker CLI as a separate string. The repository's test script is still
untrusted—that is why it runs inside the offline container—but an issue author
cannot inject a host command by writing shell punctuation in a comment.

Multiple lockfiles are rejected instead of guessed. Guessing makes builds less
reproducible and can select the wrong package manager on another machine.

## What the Docker flags protect

Containers have unsafe defaults for this use case: without explicit resource
limits, one test can use all host memory or CPU. The provider applies these
controls to every install and test container:

| Control | Purpose |
|---|---|
| numeric non-root `--user` | repository code does not run as root in the container |
| `--read-only` | the image filesystem cannot be modified |
| one temporary writable workspace | code can build/test without seeing arbitrary host paths |
| `--cap-drop ALL` | removes Linux capabilities not needed by tests |
| `no-new-privileges=true` | blocks gaining privileges through setuid/setgid binaries |
| Docker's default seccomp profile | blocks a set of dangerous system calls |
| `--cpus`, `--memory`, and equal swap limit | prevents unlimited CPU/RAM/swap use |
| `--pids-limit` | limits fork bombs |
| `nofile` ulimit | limits file-descriptor exhaustion |
| wall-clock deadline | kills hung tests even when they use little CPU |
| bounded stdout/stderr | prevents logs from filling worker memory or PostgreSQL |
| `--network none` for tests | prevents the executing test code from making network requests |

The root filesystem is read-only, while `/tmp` is a small temporary filesystem
and `/workspace` is the run's disposable copy. The container never receives
the GitHub token, App private key, database URL, Redis URL, or Docker socket.

## Why install and test are separate containers

Dependencies normally need a package registry, but tests normally do not.
Using separate containers lets DevSentinel give the minimum network access to
each stage:

```text
install: bridge network -> writes node_modules into temporary workspace
test:    no network      -> reads that workspace and executes the test script
```

Lifecycle scripts are disabled during the networked install. This reduces the
chance that a dependency's install hook can exfiltrate source code. It also
means some projects that require native build/postinstall steps will currently
fail setup. A later policy layer can run approved build steps in an additional
offline phase.

This is still not a complete egress defense. Package-manager configuration can
influence registry requests, and Docker's default bridge is not a
registry-only allowlist. A production provider needs an authenticated package
proxy that denies private address ranges and arbitrary internet destinations.

## Durable evidence and state decisions

The `runs` row records:

- `target_commit_sha`;
- `detected_package_manager`;
- `status_reason`;
- `baseline_completed_at`.

Each completed install/test stage creates a `sandbox_executions` row with the
image reference, command array, exit code, timeout flag, duration, bounded
stdout/stderr, and truncation flag. The evidence and state transition commit in
one transaction.

The current decision table is:

| Mode | Baseline result | Next state | Meaning |
|---|---|---|---|
| `TEST` | pass | `SUCCEEDED` | this captured revision is green |
| `TEST` | fail | `FAILED` | test command ran and returned non-zero |
| `FIX` | fail | `DIAGNOSING` | the bug signal was reproduced; the agent loop may start |
| `FIX` | pass | `NEEDS_HUMAN` | no failing signal exists, so autonomous editing stops |
| either | install failure or timeout | `FAILED` | the baseline could not be established safely |
| either | test timeout | `FAILED` | the wall-clock budget stopped the run |

`FAILED` does not always mean DevSentinel's infrastructure crashed. The
human-readable `status_reason` and stage evidence distinguish a test failure,
setup failure, timeout, and exhausted worker retry.

## Crash and retry behavior

BullMQ may deliver a job again after a worker crash. The processor reads the
durable run status before acting:

- a terminal or already-advanced run returns `already-processed`;
- `PREPARING`, `PROVISIONING`, and `BASELINING` may resume;
- after the SHA is recorded, a retry requests that SHA instead of the moving
  branch;
- state changes use compare-and-set updates such as
  `WHERE status = 'PREPARING'`;
- a crash after testing but before the evidence transaction may re-run the
  disposable test. Re-running is safe, although not free;
- after the final infrastructure retry, the run moves to `FAILED` instead of
  remaining stuck forever.

The temporary snapshot is removed in a `finally` block. Each container has a
unique managed name, uses `--rm`, and receives an explicit forced-removal
attempt even after the Docker CLI is killed by a timeout.

## Prove it locally

First run the fast tests, which mock the process boundary and check exact Docker
arguments, command selection, symlink rejection, output truncation, queue
routing, and token handling:

```bash
pnpm typecheck
pnpm test
```

Then run the real sandbox proof:

```bash
pnpm test:sandbox
```

It launches three real repositories:

1. passing fixture -> install `0`, test `0`;
2. failing fixture -> install `0`, test `1`;
3. infinite fixture -> deadline, forced removal.

Finally, prove the complete service path with PostgreSQL and Redis:

```bash
docker compose up -d postgres redis
pnpm db:migrate
pnpm test:integration
```

You can inspect evidence after a development run:

```bash
docker compose exec postgres psql -U devsentinel -d devsentinel \
  -c "select r.id, r.mode, r.status, r.target_commit_sha, e.phase, e.exit_code, e.timed_out, e.duration_ms from runs r left join sandbox_executions e on e.run_id = r.id order by r.created_at desc, e.created_at;"
```

## Will it work on another developer's machine?

The design is much more portable than running arbitrary commands directly on
the worker host:

- the Node runtime comes from the same Docker image;
- locked dependency commands are selected consistently;
- CPU, memory, PID, network, and timeout policy travels with DevSentinel;
- the test suite proves behavior against real containers, not only mocks;
- the official Node image is available for common Linux architectures.

But "Dockerized" is not the same as "guaranteed everywhere." Another machine
still needs a compatible Docker Engine/Desktop, enough resources, access to the
configured image and package registries, and the repository may depend on
services or system libraries not supported by this Node-only MVP. Native
dependencies can also behave differently across CPU architectures.

That is why DevSentinel reports an explicit unsupported/setup failure instead
of claiming every repository works. Later milestones can add repository-owned,
reviewed configuration for service containers, Node versions, and test
commands without accepting commands from an issue comment.

## Why this is not yet the production security boundary

Docker containers share the host kernel. The worker process also controls the
Docker daemon, which is a privileged capability even though the untrusted
container never sees its socket.

For a public multi-tenant service, keep the `BaselineSandbox` interface but
replace the local provider with:

- one disposable microVM or stronger runtime boundary per run;
- dedicated, frequently recycled worker nodes;
- rootless/user-namespace isolation where supported;
- a registry-only egress proxy and private-network deny rules;
- image allowlists pinned by digest and vulnerability policy;
- tenant quotas, admission control, cancellation, and concurrency backpressure;
- encrypted short-lived artifact storage and retention rules.

Being explicit about this gap is part of the engineering value. "Runs in
Docker" is a useful local milestone, not a complete answer to hostile code.

## Read the code in this order

1. `packages/sandbox/src/node-project.ts` — deterministic toolchain policy.
2. `packages/sandbox/src/docker-sandbox.ts` — isolation flags and two stages.
3. `packages/sandbox/src/process-runner.ts` — timeout and bounded output.
4. `apps/worker/src/repository-source.ts` — temporary local snapshots.
5. `apps/worker/src/github-repository-source.ts` — exact GitHub SHA/archive.
6. `packages/database/src/runs.ts` — compare-and-set state transitions and
   evidence transaction.
7. `packages/queue/src/outbox-publisher.ts` — event routing and stable job IDs.
8. `apps/worker/src/process-baseline.ts` — orchestration and retry resume logic.
9. `packages/sandbox/src/docker-sandbox.integration.test.ts` — the real
   pass/fail/timeout proof.
10. `apps/worker/src/baseline-pipeline.integration.test.ts` — the full durable
    PostgreSQL/Redis workflow proof.

## Small experiments to learn by changing the system

1. Change `SANDBOX_PIDS_LIMIT` to an invalid value and observe startup
   validation fail before a worker opens.
2. Lower `SANDBOX_OUTPUT_LIMIT_KB`, make a fixture print a large string, and
   inspect `output_truncated`.
3. Add both `package-lock.json` and `yarn.lock` to a temporary fixture and see
   detection refuse to guess.
4. Change the infinite fixture's timeout and compare recorded duration with the
   configured wall-clock budget.
5. Temporarily remove `--network none` in a branch, inspect the generated
   arguments test failure, then restore it. This shows how a policy regression
   can be caught without relying on code review alone.

## Official references

- [Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)
- [Docker `run` reference](https://docs.docker.com/reference/cli/docker/container/run/)
- [Docker `none` network driver](https://docs.docker.com/engine/network/drivers/none/)
- [Docker default seccomp profile](https://docs.docker.com/engine/security/seccomp/)
- [Docker Engine security and daemon attack surface](https://docs.docker.com/engine/security/)
- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)
- [GitHub installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [GitHub repository archive endpoint](https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-tar)
