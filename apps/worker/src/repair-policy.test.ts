import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyProposal, collectContext, editablePath, redact, repositoryFingerprint, validateProposal } from "./repair-policy.js";

const dirs: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "devsentinel-policy-")); dirs.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/a.js"), "export const x = 1;\n");
  await writeFile(join(root, "a.test.js"), "assert.equal(x, 2);\n");
  return root;
}
afterEach(async () => { for (const root of dirs.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("repair policy", () => {
  it.each(["../secret", "/etc/passwd", "src/../a.js", "src//a.js", "src/a.test.js", "src/tests/a.js", "package.json", ".github/workflows/ci.yml", "src/.secret.js"])("blocks %s", (path) => expect(editablePath(path)).toBe(false));
  it("allows source extensions under application-controlled repository prefixes", () => {
    expect(editablePath("apps/worker/src/process.ts")).toBe(true);
    expect(editablePath("scripts/demo.mjs")).toBe(true);
    expect(editablePath("packages/domain/test/contract.ts")).toBe(false);
  });
  it("only allows existing source files, never test edits or duplicate paths", async () => {
    const files = await collectContext(await fixture());
    expect(files.find((f) => f.path === "a.test.js")?.editable).toBe(false);
    expect(() => validateProposal({ summary: "fix", edits: [{ path: "src/new.js", content: "new" }] }, files)).toThrow();
    expect(() => validateProposal({ summary: "fix", edits: Array(2).fill({ path: "src/a.js", content: "new" }) }, files)).toThrow();
    expect(() => validateProposal({ summary: "no-op", edits: [] }, files)).toThrow();
  });
  it("applies shorter replacements and detects test tampering", async () => {
    const root = await fixture();
    await applyProposal(root, { summary: "fix", edits: [{ path: "src/a.js", content: "// x\n" }] });
    expect(await readFile(join(root, "src/a.js"), "utf8")).toBe("// x\n");
    const before = await repositoryFingerprint(root);
    await writeFile(join(root, "a.test.js"), "// deleted assertion");
    expect(await repositoryFingerprint(root)).not.toBe(before);
  });
  it("rejects symlinks and bounded context overflow", async () => {
    const root = await fixture();
    await expect(collectContext(root, 1)).rejects.toThrow("too large");
    await symlink(join(root, "a.test.js"), join(root, "src/link.js"));
    expect((await collectContext(root)).some((f) => f.path === "src/link.js")).toBe(false);
    await expect(applyProposal(root, { summary: "bad", edits: [{ path: "src/link.js", content: "bad" }] })).rejects.toThrow("symlink");
    await expect(repositoryFingerprint(root)).rejects.toThrow("symlinks");
  });
  it("redacts common credentials and excludes secret-bearing source", async () => {
    expect(redact("api_key=sk-123456789012345678901234")).not.toContain("123456789");
    const root = await fixture();
    await writeFile(join(root, "src/key.js"), 'const api_key="sk-123456789012345678901234";');
    expect((await collectContext(root)).some((f) => f.path === "src/key.js")).toBe(false);
  });
});
