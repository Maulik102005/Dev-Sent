import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentToolSession } from "./agent-tools.js";
import type { RepositoryAgentConfig } from "./repository-guidance.js";

const roots: string[] = [];
const config: RepositoryAgentConfig = {
  version: 1,
  guidance: { path: "DEVSENTINEL.md", version: "1" },
  supportedSourcePaths: ["src"],
  excludedPaths: ["src/generated"],
  testProfiles: [{ name: "unit", relevantPaths: ["test/a.test.js"], runner: "package-test" }],
  regressionTests: { enabled: true, allowedPaths: ["test"] },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "devsentinel-tools-")); roots.push(root);
  await mkdir(join(root, "src")); await mkdir(join(root, "src/generated")); await mkdir(join(root, "test"));
  await writeFile(join(root, "src/a.js"), "export const boundary = 10;\n");
  await writeFile(join(root, "src/generated/a.js"), "export const generated = true;\n");
  await writeFile(join(root, "test/a.test.js"), "// boundary assertion\n");
  await writeFile(join(root, "src/secret.js"), "const api_key='sk-123456789012345678901234';\n");
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function session(root: string, budget = { maxCalls: 10, maxOutputBytes: 10000, deadlineMs: Date.now() + 10000 }) {
  return new AgentToolSession({ root, config, approvedPaths: ["src/a.js"], excludedPaths: [], allowRegressionTests: true, budget });
}

describe("bounded agent tools", () => {
  it("enforces phase and path permissions in code", async () => {
    const tools = session(await fixture());
    await expect(tools.execute("propose_patch", { summary: "skip plan", edits: [{ path: "src/a.js", content: "x" }] })).rejects.toThrow("not available");
    await tools.execute("submit_plan", { suspectedCause: "boundary", evidenceReferences: ["src/a.js:1"], intendedFiles: ["src/a.js"], scopeExclusions: ["generated"], verificationSteps: ["full suite"] });
    await expect(tools.execute("propose_patch", { summary: "generated", edits: [{ path: "src/generated/a.js", content: "x" }] })).rejects.toThrow("out-of-scope");
    await tools.execute("propose_patch", { summary: "fix", edits: [{ path: "src/a.js", content: "export const boundary = 11;\n" }] });
    expect(tools.proposal?.edits[0]?.path).toBe("src/a.js");
  });

  it("filters secret-bearing evidence and permits only application-approved test profiles", async () => {
    const tools = session(await fixture());
    await expect(tools.execute("read_text", { path: "src/secret.js", startLine: 1, endLine: 2 })).rejects.toThrow("secret-like");
    expect(await tools.execute("request_test", { profile: "unit" })).toMatchObject({ approved: true, runner: "package-test" });
    await expect(tools.execute("request_test", { profile: "../../shell" })).rejects.toThrow("Unknown");
  });

  it("keeps call and output budgets across every phase in one attempt", async () => {
    const root = await fixture();
    const calls = session(root, { maxCalls: 1, maxOutputBytes: 10000, deadlineMs: Date.now() + 10000 });
    await calls.execute("list_files", {});
    await expect(calls.execute("list_files", {})).rejects.toThrow("call budget");
    const output = session(root, { maxCalls: 10, maxOutputBytes: 5, deadlineMs: Date.now() + 10000 });
    await expect(output.execute("list_files", {})).rejects.toThrow("output budget");
    const expired = session(root, { maxCalls: 10, maxOutputBytes: 1000, deadlineMs: Date.now() - 1 });
    await expect(expired.execute("list_files", {})).rejects.toThrow("deadline");
  });

  it("keeps regression creation separate from source patching", async () => {
    const tools = session(await fixture());
    await tools.execute("submit_plan", { suspectedCause: "missing boundary", evidenceReferences: ["issue"], intendedFiles: ["src/a.js"], scopeExclusions: ["existing tests"], verificationSteps: ["frozen reproducer", "full suite"] });
    const result = await tools.execute("propose_regression_test", { summary: "captures boundary", path: "test/new-boundary.test.js", content: "throw new Error('fails before repair');\n" });
    expect(result).toMatchObject({ accepted: true, path: "test/new-boundary.test.js" });
    expect(tools.regressionTest?.hash).toMatch(/^[0-9a-f]{64}$/);
    await expect(tools.execute("propose_regression_test", { summary: "replace", path: "test/a.test.js", content: "changed" })).rejects.toThrow("replace");
  });

  it("retrieves relevant context without failing when per-file provenance is larger than the database budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "devsentinel-tools-large-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await Promise.all(Array.from({ length: 1_005 }, (_, index) =>
      writeFile(join(root, "src", `file-${String(index).padStart(4, "0")}.js`), `export const boundary${index} = ${index};\n`),
    ));
    const tools = session(root);
    const context = await tools.seedContext("boundary 1004", 4_096);
    expect(context.files.length).toBeGreaterThan(0);
    expect(context.provenance).toHaveLength(950);
    expect(context.provenance.at(-1)).toMatchObject({ kind: "omission", selected: false });
  });
});
