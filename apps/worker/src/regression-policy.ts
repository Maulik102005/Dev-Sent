import { createHash } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { redact } from "./repair-policy.js";
import { safeRepositoryPath } from "./repository-guidance.js";

export const regressionTestProposalSchema = z.object({
  summary: z.string().min(1).max(2_000),
  path: z.string().min(1).max(240),
  content: z.string().min(1).max(32 * 1_024),
}).strict();

export type RegressionTestProposal = z.infer<typeof regressionTestProposalSchema>;

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

export function validateRegressionTestProposal(value: unknown, allowedPaths: string[]): RegressionTestProposal & { hash: string } {
  const proposal = regressionTestProposalSchema.parse(value);
  if (!safeRepositoryPath(proposal.path) || !/\.(?:test|spec)\.(?:js|mjs|cjs|ts|tsx|jsx)$/i.test(proposal.path)) throw new Error("Regression reproducer must be a bounded test file path");
  if (!allowedPaths.some((prefix) => under(proposal.path, prefix))) throw new Error("Regression reproducer is outside configured audited test paths");
  if (proposal.content.includes("\0") || redact(proposal.content) !== proposal.content) throw new Error("Regression reproducer contains binary or secret-like content");
  return { ...proposal, hash: createHash("sha256").update(proposal.content).digest("hex") };
}

export async function applyFrozenRegressionTest(root: string, proposal: RegressionTestProposal & { hash?: string }): Promise<void> {
  const expected = createHash("sha256").update(proposal.content).digest("hex");
  if (proposal.hash && proposal.hash !== expected) throw new Error("Frozen regression reproducer hash does not match its content");
  let current = root;
  for (const part of dirname(proposal.path).split("/")) {
    if (part === ".") continue;
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Regression reproducer parent is not a regular directory");
  }
  const target = join(root, proposal.path);
  try {
    await lstat(target);
    throw new Error("Regression reproducer cannot replace an existing file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(target, proposal.content, { flag: "wx", mode: 0o600 });
}
