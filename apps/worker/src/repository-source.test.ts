import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalDirectoryRepositorySource } from "./repository-source.js";

const temporaryDirectories: string[] = [];

async function temporarySource(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "devsentinel-local-source-"));
  temporaryDirectories.push(path);
  await writeFile(join(path, "package.json"), "{}\n");
  await mkdir(join(path, "node_modules"));
  await writeFile(join(path, "node_modules", "must-not-copy"), "large cache");
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("LocalDirectoryRepositorySource", () => {
  it("creates a stable, dependency-free temporary snapshot and removes it", async () => {
    const sourcePath = await temporarySource();
    const source = new LocalDirectoryRepositorySource(sourcePath);
    const target = {
      githubInstallationId: 1,
      githubRepositoryId: 2,
      repositoryFullName: "local/fixture",
      ref: "main",
    };
    const first = await source.materialize(target);
    const second = await source.materialize(target);

    expect(first.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(second.commitSha).toBe(first.commitSha);
    await expect(access(join(first.path, "package.json"))).resolves.toBeUndefined();
    await expect(access(join(first.path, "node_modules"))).rejects.toThrow();

    const firstPath = first.path;
    await first.cleanup();
    await second.cleanup();
    await expect(access(firstPath)).rejects.toThrow();
  });
});
