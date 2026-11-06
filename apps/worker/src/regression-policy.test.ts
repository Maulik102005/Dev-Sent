import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyFrozenRegressionTest, validateRegressionTestProposal } from "./regression-policy.js";

const roots: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), "devsentinel-regression-")); roots.push(root); await mkdir(join(root, "test")); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("audited regression reproducer", () => {
  it("permits only a new bounded test under configured paths and freezes a hash", async () => {
    const root = await fixture();
    const proposal = validateRegressionTestProposal({ summary: "boundary", path: "test/boundary.test.js", content: "throw new Error('reproduced');\n" }, ["test"]);
    expect(proposal.hash).toMatch(/^[0-9a-f]{64}$/);
    await applyFrozenRegressionTest(root, proposal);
    expect(await readFile(join(root, proposal.path), "utf8")).toBe(proposal.content);
    await expect(applyFrozenRegressionTest(root, proposal)).rejects.toThrow("cannot replace");
  });

  it("cannot weaken an existing test, escape, or carry a secret", async () => {
    const root = await fixture();
    await writeFile(join(root, "test/existing.test.js"), "existing");
    const existing = validateRegressionTestProposal({ summary: "replace", path: "test/existing.test.js", content: "changed" }, ["test"]);
    await expect(applyFrozenRegressionTest(root, existing)).rejects.toThrow("cannot replace");
    expect(() => validateRegressionTestProposal({ summary: "escape", path: "../bad.test.js", content: "x" }, ["test"])).toThrow();
    expect(() => validateRegressionTestProposal({ summary: "secret", path: "test/new.test.js", content: "api_key=sk-123456789012345678901234" }, ["test"])).toThrow();
  });
});
