import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectNodeProject, UnsupportedNodeProjectError } from "./node-project.js";

const workspaces: string[] = [];

async function workspace(files: Record<string, string>): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "devsentinel-detect-"));
  workspaces.push(path);

  await Promise.all(
    Object.entries(files).map(([name, contents]) =>
      writeFile(join(path, name), contents),
    ),
  );

  return path;
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("detectNodeProject", () => {
  it("selects deterministic npm commands from package-lock.json", async () => {
    const path = await workspace({
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "package-lock.json": "{}",
    });

    await expect(detectNodeProject(path)).resolves.toEqual({
      packageManager: "npm",
      packageManagerVersion: null,
      installCommand: [
        "npm",
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      testCommand: ["npm", "test"],
    });
  });

  it("uses a pinned pnpm version through Corepack", async () => {
    const path = await workspace({
      "package.json": JSON.stringify({
        packageManager: "pnpm@11.9.0",
        scripts: { test: "vitest run" },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    await expect(detectNodeProject(path)).resolves.toMatchObject({
      packageManager: "pnpm",
      packageManagerVersion: "11.9.0",
      installCommand: [
        "corepack",
        "pnpm",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
      ],
      testCommand: ["corepack", "pnpm", "test"],
    });
  });

  it("rejects ambiguous lockfiles instead of guessing", async () => {
    const path = await workspace({
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "package-lock.json": "{}",
      "yarn.lock": "",
    });

    await expect(detectNodeProject(path)).rejects.toThrow(
      "Exactly one supported lockfile is required",
    );
  });

  it("rejects a package.json symlink before reading outside the workspace", async () => {
    const path = await workspace({ "package-lock.json": "{}" });
    await symlink("/etc/passwd", join(path, "package.json"));

    await expect(detectNodeProject(path)).rejects.toBeInstanceOf(
      UnsupportedNodeProjectError,
    );
  });
});
