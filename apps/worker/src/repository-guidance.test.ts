import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadRepositoryGuidance, repositoryAgentConfigSchema } from "./repository-guidance.js";

const roots: string[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), "devsentinel-guidance-")); roots.push(value); return value; }
afterEach(async () => { for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true }); });

describe("repository guidance", () => {
  it("uses safe defaults without granting commands or budgets", async () => {
    const loaded = await loadRepositoryGuidance(await root());
    expect(loaded.config).toMatchObject({ version: 1, supportedSourcePaths: ["src", "lib"] });
    expect(JSON.stringify(loaded.config)).not.toMatch(/command|maxTokens|budget/i);
  });

  it("loads and hashes bounded maintainer guidance", async () => {
    const path = await root();
    await writeFile(join(path, ".devsentinel.json"), JSON.stringify({
      version: 1,
      guidance: { path: "DEVSENTINEL.md", version: "checkout-2" },
      supportedSourcePaths: ["src"],
      excludedPaths: ["src/generated"],
      testProfiles: [{ name: "checkout", relevantPaths: ["test/checkout.test.js"], runner: "package-test" }],
      regressionTests: { enabled: true, allowedPaths: ["test"] },
    }));
    await writeFile(join(path, "DEVSENTINEL.md"), "Keep currency values in cents.\n");
    const loaded = await loadRepositoryGuidance(path);
    expect(loaded).toMatchObject({ version: "checkout-2", content: "Keep currency values in cents.\n" });
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects arbitrary commands, traversal, links, and secret-like guidance", async () => {
    expect(() => repositoryAgentConfigSchema.parse({ version: 1, testCommand: "rm -rf /" })).toThrow();
    expect(() => repositoryAgentConfigSchema.parse({ version: 1, supportedSourcePaths: ["../private"] })).toThrow();
    const path = await root();
    await writeFile(join(path, "real.md"), "safe");
    await symlink(join(path, "real.md"), join(path, "DEVSENTINEL.md"));
    await expect(loadRepositoryGuidance(path)).rejects.toThrow("regular non-linked");
    await rm(join(path, "DEVSENTINEL.md"));
    await writeFile(join(path, "DEVSENTINEL.md"), "api_key=sk-123456789012345678901234");
    await expect(loadRepositoryGuidance(path)).rejects.toThrow("secret-like");
  });
});
