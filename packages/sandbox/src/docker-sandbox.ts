import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";

import { SpawnProcessRunner, type ProcessRunner } from "./process-runner.js";
import type {
  BaselineExecutionRequest,
  BaselineExecutionResult,
  BaselineSandbox,
  SandboxCommandResult,
} from "./types.js";

export interface DockerSandboxPolicy {
  image: string;
  cpuLimit: number;
  memoryMb: number;
  pidsLimit: number;
  installTimeoutMs: number;
  testTimeoutMs: number;
  outputLimitBytes: number;
  user: string;
}

export const defaultDockerSandboxPolicy: DockerSandboxPolicy = {
  image: "node:22.23.2-bookworm-slim",
  cpuLimit: 1,
  memoryMb: 1_024,
  pidsLimit: 256,
  installTimeoutMs: 300_000,
  testTimeoutMs: 300_000,
  outputLimitBytes: 256 * 1_024,
  user: `${process.getuid?.() ?? 1_000}:${process.getgid?.() ?? 1_000}`,
};

function validatePolicy(policy: DockerSandboxPolicy): void {
  if (!policy.image.trim() || /[\r\n]/.test(policy.image)) {
    throw new Error("Sandbox image must be a non-empty single-line reference");
  }

  if (!Number.isFinite(policy.cpuLimit) || policy.cpuLimit <= 0) {
    throw new Error("Sandbox CPU limit must be positive");
  }

  for (const [name, value] of [
    ["memory", policy.memoryMb],
    ["process", policy.pidsLimit],
    ["install timeout", policy.installTimeoutMs],
    ["test timeout", policy.testTimeoutMs],
    ["output", policy.outputLimitBytes],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`Sandbox ${name} limit must be a positive integer`);
    }
  }

  if (!/^\d+:\d+$/.test(policy.user)) {
    throw new Error("Sandbox user must use numeric uid:gid form");
  }
}

function safeContainerSegment(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return safe.slice(0, 48) || "run";
}

export function dockerRunArguments(input: {
  containerName: string;
  workspacePath: string;
  command: readonly string[];
  network: "bridge" | "none";
  policy: DockerSandboxPolicy;
}): string[] {
  if (!isAbsolute(input.workspacePath)) {
    throw new Error("Sandbox workspace path must be absolute");
  }

  if (/[,\r\n]/.test(input.workspacePath)) {
    throw new Error("Sandbox workspace path contains unsupported characters");
  }

  if (input.command.length === 0 || input.command.some((part) => part.length === 0)) {
    throw new Error("Sandbox command must contain non-empty arguments");
  }

  const memory = `${input.policy.memoryMb}m`;

  return [
    "run",
    "--rm",
    "--name",
    input.containerName,
    "--init",
    "--pull=missing",
    "--network",
    input.network,
    "--ipc",
    "none",
    "--read-only",
    "--user",
    input.policy.user,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--cpus",
    String(input.policy.cpuLimit),
    "--memory",
    memory,
    "--memory-swap",
    memory,
    "--pids-limit",
    String(input.policy.pidsLimit),
    "--ulimit",
    "nofile=1024:1024",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
    "--mount",
    `type=bind,source=${input.workspacePath},target=/workspace`,
    "--workdir",
    "/workspace",
    "--env",
    "CI=true",
    "--env",
    "HOME=/tmp/devsentinel-home",
    "--env",
    "COREPACK_HOME=/workspace/.devsentinel/corepack",
    "--env",
    "npm_config_cache=/workspace/.devsentinel/npm-cache",
    "--label",
    "devsentinel.managed=true",
    input.policy.image,
    ...input.command,
  ];
}

export class DockerSandboxExecutor implements BaselineSandbox {
  private readonly policy: DockerSandboxPolicy;

  constructor(
    policy: Partial<DockerSandboxPolicy> = {},
    private readonly processRunner: ProcessRunner = new SpawnProcessRunner(),
    private readonly dockerExecutable = "docker",
  ) {
    this.policy = { ...defaultDockerSandboxPolicy, ...policy };
    validatePolicy(this.policy);
  }

  async executeBaseline(
    request: BaselineExecutionRequest,
  ): Promise<BaselineExecutionResult> {
    request.signal?.throwIfAborted();
    const remaining = (limit: number) => request.deadlineMs === undefined ? limit : Math.max(1, Math.min(limit, request.deadlineMs - Date.now()));
    const install = await this.runStage({
      runId: request.runId,
      stage: "install",
      workspacePath: request.workspacePath,
      command: request.plan.installCommand,
      network: "bridge",
      timeoutMs: remaining(this.policy.installTimeoutMs),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (install.timedOut || install.exitCode !== 0) {
      return { image: this.policy.image, install, test: null };
    }

    request.signal?.throwIfAborted();
    const test = await this.runStage({
      runId: request.runId,
      stage: "test",
      workspacePath: request.workspacePath,
      command: request.plan.testCommand,
      network: "none",
      timeoutMs: remaining(this.policy.testTimeoutMs),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    return { image: this.policy.image, install, test };
  }

  private async runStage(input: {
    runId: string;
    stage: "install" | "test";
    workspacePath: string;
    command: readonly string[];
    network: "bridge" | "none";
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<SandboxCommandResult> {
    const containerName = `devsentinel-${safeContainerSegment(input.runId)}-${input.stage}-${randomBytes(4).toString("hex")}`;

    try {
      const result = await this.processRunner.run({
        executable: this.dockerExecutable,
        args: dockerRunArguments({
          containerName,
          workspacePath: input.workspacePath,
          command: input.command,
          network: input.network,
          policy: this.policy,
        }),
        timeoutMs: input.timeoutMs,
        outputLimitBytes: this.policy.outputLimitBytes,
        ...(input.signal ? { signal: input.signal } : {}),
      });

      return { command: input.command, ...result };
    } finally {
      const cleanup = await this.processRunner
        .run({
          executable: this.dockerExecutable,
          args: ["container", "rm", "--force", containerName],
          timeoutMs: 10_000,
          outputLimitBytes: 4_096,
        });
      if (cleanup.timedOut || (cleanup.exitCode !== 0 && !/no such container/i.test(cleanup.stderr))) {
        throw new Error("Sandbox cleanup failed; operator must inspect managed containers before retrying");
      }
    }
  }
}
