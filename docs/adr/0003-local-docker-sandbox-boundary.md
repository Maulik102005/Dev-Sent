# ADR 0003: use a hardened Docker provider locally, not as the final multi-tenant boundary

- Status: Accepted
- Date: 2026-09-01

## Context

DevSentinel must execute repository-controlled dependency and test commands.
Running those commands in the API, dispatcher, or worker process would expose
service credentials, host files, network access, and resources. A useful local
milestone also needs to be easy for another developer to reproduce without a
cloud account.

Containers provide namespaces, cgroups, capabilities, seccomp integration, a
read-only image filesystem, and explicit network policy. They still share the
host kernel. The Docker daemon is privileged and its control socket is
effectively administrative access to the host.

The repository may need network access to resolve locked dependencies, while
the actual test should not require arbitrary egress. Package lifecycle scripts
are themselves code and could use an install container's network.

## Decision

Define repository acquisition and execution behind `RepositorySource` and
`BaselineSandbox` interfaces.

The local `DockerSandboxExecutor` will:

1. accept only a temporary absolute workspace produced by a trusted source
   adapter;
2. select commands from a strict Node lockfile policy, never issue/model text;
3. use separate install and test containers;
4. disable install lifecycle scripts;
5. use Docker bridge networking only for dependency resolution;
6. use Docker's `none` network for the test container;
7. run as a numeric non-root user with a read-only root filesystem, all
   capabilities dropped, `no-new-privileges`, and Docker's default seccomp
   profile;
8. enforce CPU, memory/swap, PID, open-file, output, and wall-clock limits;
9. never mount the Docker socket or pass service/GitHub credentials;
10. force container cleanup in a `finally` path and persist bounded evidence.

The configured Node image is patch-version pinned and recorded with each
execution. Production policy will require an immutable image digest.

Docker is accepted for local development and CI evidence. It is explicitly not
accepted as the only hostile multi-tenant production boundary. A deployed
provider must use dedicated nodes and a stronger runtime such as a microVM,
gVisor, or Kata Containers, plus controlled egress.

## Consequences

Positive:

- contributors can prove pass, fail, timeout, and cleanup with one local Docker
  daemon;
- the orchestration and database code are independent of the future cloud
  sandbox vendor;
- tests have no network and cannot see worker secrets;
- resource exhaustion and unbounded log failure modes are controlled;
- the project demonstrates honest trust-boundary analysis rather than treating
  "inside Docker" as synonymous with secure.

Negative:

- repositories needing install/postinstall build hooks may fail the current
  setup policy;
- the networked package-manager phase is not yet restricted to approved
  registries and can still be influenced by repository configuration;
- Docker availability, kernel behavior, CPU architecture, and native
  dependencies affect portability;
- the worker user can control the Docker daemon, so worker-host compromise has
  a large blast radius;
- a crash after execution but before the result transaction can cause a safe
  but costly repeated test.

## Alternatives considered

### Run commands directly on the worker

Rejected. It collapses the trust boundary and exposes the worker environment,
filesystem, processes, and network to repository code.

### Docker Compose files supplied by each repository

Deferred. Repository-controlled mounts, privileged flags, host networking, and
service definitions would let untrusted input configure the security boundary
itself. A future reviewed configuration format must expose a much smaller
allowlist.

### Start immediately with a cloud microVM provider

Deferred, not rejected. It is the intended production direction, but it adds
cloud credentials, cost, lifecycle APIs, remote logs, image management, and
cleanup recovery before the workflow contract is proven locally.

### Keep install and tests in one networked container

Rejected. It is simpler but gives arbitrary test code unnecessary egress and
makes the network privilege last for the entire run.

## Follow-up requirements before public deployment

- pin images by digest and enforce an allowlist/scanning policy;
- add a registry proxy with domain and private-network restrictions;
- implement VM-grade provider isolation on dedicated, recycled nodes;
- add admission control, per-tenant concurrency and cost quotas, cancellation,
  and dead-letter recovery;
- define reviewed repository configuration for runtime versions, offline build
  steps, and dependent services;
- add artifact encryption, retention limits, and sensitive-log redaction.
