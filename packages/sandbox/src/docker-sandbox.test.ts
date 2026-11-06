import { describe, expect, it } from "vitest";

import {
  defaultDockerSandboxPolicy,
  DockerSandboxExecutor,
  dockerRunArguments,
} from "./docker-sandbox.js";
import type {
  ProcessRunRequest,
  ProcessRunResult,
  ProcessRunner,
} from "./process-runner.js";

class RecordingProcessRunner implements ProcessRunner {
  readonly requests: ProcessRunRequest[] = [];
  private responseIndex = 0;

  constructor(private readonly responses: ProcessRunResult[]) {}

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.requests.push(request);
    const isCleanup = request.args[0] === "container";

    if (isCleanup) {
      return result(0);
    }

    const response = this.responses[this.responseIndex];
    this.responseIndex += 1;

    if (!response) {
      throw new Error("Missing fake process response");
    }

    return response;
  }
}

function result(
  exitCode: number | null,
  overrides: Partial<ProcessRunResult> = {},
): ProcessRunResult {
  return {
    exitCode,
    timedOut: false,
    durationMs: 25,
    stdout: "",
    stderr: "",
    outputTruncated: false,
    ...overrides,
  };
}

describe("dockerRunArguments", () => {
  it("applies the sandbox hardening policy and keeps command arguments separate", () => {
    const args = dockerRunArguments({
      containerName: "devsentinel-run-test",
      workspacePath: "/tmp/devsentinel-workspace",
      command: ["npm", "test", "value with spaces"],
      network: "none",
      policy: defaultDockerSandboxPolicy,
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges=true",
        "--pids-limit",
        "256",
        "--network",
        "none",
      ]),
    );
    expect(args.slice(-3)).toEqual(["npm", "test", "value with spaces"]);
    expect(args).not.toContain("sh");
    expect(args).not.toContain("bash");
  });
});

describe("DockerSandboxExecutor", () => {
  const request = {
    runId: "2b7054f5-353f-4710-9270-e3a773817c2c",
    workspacePath: "/tmp/devsentinel-workspace",
    plan: {
      packageManager: "npm" as const,
      packageManagerVersion: null,
      installCommand: [
        "npm",
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      testCommand: ["npm", "test"],
    },
  };

  it("allows registry networking only during install", async () => {
    const runner = new RecordingProcessRunner([result(0), result(0)]);
    const sandbox = new DockerSandboxExecutor({}, runner);

    await expect(sandbox.executeBaseline(request)).resolves.toMatchObject({
      install: { exitCode: 0 },
      test: { exitCode: 0 },
    });

    const dockerRuns = runner.requests.filter(
      (recorded) => recorded.args[0] === "run",
    );
    expect(dockerRuns).toHaveLength(2);
    expect(dockerRuns[0]?.args).toContain("bridge");
    expect(dockerRuns[1]?.args).toContain("none");
    expect(
      runner.requests.filter((recorded) => recorded.args[0] === "container"),
    ).toHaveLength(2);
  });

  it("does not run tests when locked dependency installation fails", async () => {
    const runner = new RecordingProcessRunner([
      result(1, { stderr: "lockfile mismatch" }),
    ]);
    const sandbox = new DockerSandboxExecutor({}, runner);

    await expect(sandbox.executeBaseline(request)).resolves.toMatchObject({
      install: { exitCode: 1, stderr: "lockfile mismatch" },
      test: null,
    });
    expect(
      runner.requests.filter((recorded) => recorded.args[0] === "run"),
    ).toHaveLength(1);
  });

  it("reports a timed-out test and still requests container cleanup", async () => {
    const runner = new RecordingProcessRunner([
      result(0),
      result(null, { timedOut: true, durationMs: 100 }),
    ]);
    const sandbox = new DockerSandboxExecutor({}, runner);

    await expect(sandbox.executeBaseline(request)).resolves.toMatchObject({
      test: { timedOut: true, exitCode: null },
    });
    expect(
      runner.requests.filter((recorded) => recorded.args[0] === "container"),
    ).toHaveLength(2);
  });
  it("bounds stage timeouts by the run deadline and forwards cancellation", async () => {
    const runner = new RecordingProcessRunner([result(0), result(0)]);
    const signal = new AbortController().signal;
    await new DockerSandboxExecutor({}, runner).executeBaseline({ ...request, signal, deadlineMs: Date.now() + 1000 });
    const stages = runner.requests.filter((r) => r.args[0] === "run");
    expect(stages.every((r) => r.timeoutMs > 0 && r.timeoutMs <= 1000 && r.signal === signal)).toBe(true);
  });
  it("refuses successful evidence when cleanup fails", async () => {
    const runner: ProcessRunner = { run: async (request) => request.args[0] === "container" ? result(1, { stderr: "daemon unavailable" }) : result(0) };
    await expect(new DockerSandboxExecutor({}, runner).executeBaseline(request)).rejects.toThrow("cleanup failed");
  });
});
