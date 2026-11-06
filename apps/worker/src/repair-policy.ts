import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const proposalSchema = z.object({
  summary: z.string().min(1).max(4000),
  edits: z.array(z.object({
    path: z.string().min(1).max(240),
    content: z.string().min(1).max(64000),
  }).strict()).max(5),
}).strict();
export type RepairProposal = z.infer<typeof proposalSchema>;
export type SourceFile = { path: string; content: string; editable: boolean };

export function editablePath(path: string): boolean {
  return /^[a-zA-Z0-9_./-]+\.(js|mjs|cjs|ts|tsx|jsx)$/.test(path)
    && !path.startsWith("/")
    && !path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))
    && !/(^|\/)(__tests__|tests?|fixtures?|mocks?|node_modules|dist|build|coverage)(\/|$)|\.(test|spec)\./i.test(path);
}

export function redact(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED TOKEN]")
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+|token\s+)?)[^\s"',]+/gi, "$1[REDACTED]")
    .replace(/((?:password|api[_-]?key|secret|access[_-]?token)\s*[=:]\s*["']?)[^\s"',;]+/gi, "$1[REDACTED]");
}

// Never follow repository symlinks. Only bounded, allowlisted text enters the model.
export async function collectContext(root: string, maximumBytes = 48000): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  let bytes = 0;
  let entriesSeen = 0;
  async function visit(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++entriesSeen > 5000) throw new Error("Repository context entry limit exceeded");
      if (entry.name.startsWith(".") || ["node_modules", "dist", "build", "coverage"].includes(entry.name)) continue;
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (path.split("/").length < 10) await visit(join(dir, entry.name), `${path}/`);
      } else if (entry.isFile() && /\.(js|mjs|cjs|ts|tsx|jsx)$/.test(path)) {
        const info = await lstat(join(root, path));
        if (info.size > 64000) continue;
        const content = await readFile(join(root, path), "utf8");
        if (content.includes("\0") || redact(content) !== content) continue;
        bytes += Buffer.byteLength(content);
        if (bytes > maximumBytes) throw new Error("Repository context is too large for this policy; narrow its scope before retrying");
        files.push({ path, content, editable: editablePath(path) && (info.mode & 0o111) === 0 && info.nlink === 1 });
      }
    }
  }
  await visit(root, "");
  return files;
}

export function validateProposal(value: unknown, original: SourceFile[]): RepairProposal {
  const proposal = proposalSchema.parse(value);
  const seen = new Set<string>();
  let bytes = 0;
  for (const edit of proposal.edits) {
    const file = original.find((item) => item.path === edit.path);
    if (!file?.editable || !editablePath(edit.path) || seen.has(edit.path)) throw new Error("Patch policy rejected a protected, unknown, or duplicate path");
    if (edit.content.includes("\0") || redact(edit.content) !== edit.content) throw new Error("Patch policy rejected binary or secret-like content");
    bytes += Buffer.byteLength(edit.content);
    if (bytes > 64000) throw new Error("Patch exceeds the total content budget");
    seen.add(edit.path);
  }
  if (!proposal.edits.some((edit) => original.find((file) => file.path === edit.path)?.content !== edit.content)) {
    throw new Error("Model did not propose a source change");
  }
  return proposal;
}

export async function applyProposal(root: string, proposal: RepairProposal): Promise<void> {
  for (const edit of proposal.edits) {
    if (!editablePath(edit.path)) throw new Error("Unsafe edit path");
    let parent = root;
    for (const part of edit.path.split("/")) {
      parent = join(parent, part);
      const info = await lstat(parent);
      if (info.isSymbolicLink()) throw new Error("Patch path contains a symlink");
    }
    const info = await lstat(parent);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Patch target is not a regular unlinked source file");
    await writeFile(parent, edit.content);
  }
}

// Hash all original repository files, including tests/manifests, before and after execution.
// Installed dependencies and runner cache are excluded; neither is published as source.
export async function repositoryFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  let size = 0;
  let count = 0;
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(join(root, dir), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if ([".git", "node_modules", ".devsentinel"].includes(entry.name)) continue;
      if (++count > 20000) throw new Error("Repository file limit exceeded");
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      hash.update(path + "\0");
      if (entry.isDirectory()) { hash.update("directory\0"); await visit(path); }
      else if (entry.isFile()) {
        const stat = await lstat(join(root, path));
        size += stat.size;
        if (size > 32 * 1024 * 1024) throw new Error("Repository fingerprint byte limit exceeded");
        hash.update(String(stat.mode & 0o777));
        hash.update(await readFile(join(root, path)));
      } else throw new Error("Repair requires a repository without symlinks or special files");
      hash.update("\0");
    }
  }
  await visit("");
  return hash.digest("hex");
}
