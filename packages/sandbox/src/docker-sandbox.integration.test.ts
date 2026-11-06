import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { DockerSandboxExecutor } from "./docker-sandbox.js";
import { detectNodeProject } from "./node-project.js";
import { SpawnProcessRunner } from "./process-runner.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryDirectories: string[] = [];

async function fixture(name: string): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "devsentinel-docker-test-"));
  const workspace = join(temporaryRoot, "workspace");
  temporaryDirectories.push(temporaryRoot);
  await cp(resolve(workspaceRoot, "fixtures/sandbox", name), workspace, {
    recursive: true,
  });
  return workspace;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function remainingManagedContainers(runId: string): Promise<string> {
  const result = await new SpawnProcessRunner().run({
    executable: "docker",
    args: [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `name=devsentinel-${runId}`,
    ],
    timeoutMs: 10_000,
    outputLimitBytes: 4_096,
  });

  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect Docker cleanup: ${result.stderr}`);
  }

  return result.stdout.trim();
}

describe("DockerSandboxExecutor with the real Docker daemon", () => {
  it("installs and passes a Node fixture inside hardened containers", async () => {
    const runId = "sandbox-pass";
    const workspacePath = await fixture("passing-node");
    const plan = await detectNodeProject(workspacePath);
    const sandbox = new DockerSandboxExecutor({ testTimeoutMs: 10_000 });

    const result = await sandbox.executeBaseline({ runId, workspacePath, plan });

    expect(result.install).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.test).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.test?.stdout).toContain("pass 1");
    await expect(remainingManagedContainers(runId)).resolves.toBe("");
  });

  it("captures a genuine failing baseline without treating it as infrastructure failure", async () => {
    const runId = "sandbox-fail";
    const workspacePath = await fixture("failing-node");
    const plan = await detectNodeProject(workspacePath);
    const sandbox = new DockerSandboxExecutor({ testTimeoutMs: 10_000 });

    const result = await sandbox.executeBaseline({ runId, workspacePath, plan });

    expect(result.install.exitCode).toBe(0);
    expect(result.test).toMatchObject({ exitCode: 1, timedOut: false });
    expect(result.test?.stdout).toContain("fail 1");
    await expect(remainingManagedContainers(runId)).resolves.toBe("");
  });

  it("kills and removes a test container after its wall-clock budget expires", async () => {
    const runId = "sandbox-timeout";
    const workspacePath = await fixture("timeout-node");
    const plan = await detectNodeProject(workspacePath);
    const sandbox = new DockerSandboxExecutor({ testTimeoutMs: 500 });

    const result = await sandbox.executeBaseline({ runId, workspacePath, plan });

    expect(result.install.exitCode).toBe(0);
    expect(result.test).toMatchObject({ exitCode: null, timedOut: true });
    await expect(remainingManagedContainers(runId)).resolves.toBe("");
  });
});
