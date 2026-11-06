import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { redact } from "./repair-policy.js";

export function safeRepositoryPath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !path.startsWith("/") &&
    !path.includes("\\") && !path.includes("*") &&
    path.split("/").every((part) => Boolean(part) && part !== "." && part !== ".." && !part.startsWith("."));
}

const repositoryPathSchema = z.string().refine(safeRepositoryPath, "Unsafe repository path");

export const repositoryAgentConfigSchema = z.object({
  version: z.literal(1),
  guidance: z.object({
    path: repositoryPathSchema.default("DEVSENTINEL.md"),
    version: z.string().min(1).max(80).default("1"),
  }).strict().default({ path: "DEVSENTINEL.md", version: "1" }),
  supportedSourcePaths: z.array(repositoryPathSchema).min(1).max(20).default(["src", "lib"]),
  excludedPaths: z.array(repositoryPathSchema).max(50).default([]),
  testProfiles: z.array(z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    relevantPaths: z.array(repositoryPathSchema).min(1).max(30),
    runner: z.literal("package-test"),
  }).strict()).max(20).default([]),
  regressionTests: z.object({
    enabled: z.boolean().default(false),
    allowedPaths: z.array(repositoryPathSchema).max(10).default(["test", "tests"]),
  }).strict().default({ enabled: false, allowedPaths: ["test", "tests"] }),
}).strict();

export type RepositoryAgentConfig = z.infer<typeof repositoryAgentConfigSchema>;

const defaultConfig: RepositoryAgentConfig = repositoryAgentConfigSchema.parse({ version: 1 });

async function optionalRegularFile(root: string, path: string, maximumBytes: number): Promise<string | null> {
  try {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error(`${path} must be a regular non-linked file`);
    if (info.size > maximumBytes) throw new Error(`${path} exceeds its ${maximumBytes}-byte limit`);
    const content = await readFile(join(root, path), "utf8");
    if (content.includes("\0")) throw new Error(`${path} is not bounded text`);
    return content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export interface LoadedRepositoryGuidance {
  path: string;
  content: string;
  hash: string;
  version: string;
  config: RepositoryAgentConfig;
}

export async function loadRepositoryGuidance(root: string): Promise<LoadedRepositoryGuidance> {
  const rawConfig = await optionalRegularFile(root, ".devsentinel.json", 32 * 1_024);
  let config = defaultConfig;
  if (rawConfig) {
    let parsed: unknown;
    try { parsed = JSON.parse(rawConfig); }
    catch { throw new Error(".devsentinel.json is not valid JSON"); }
    config = repositoryAgentConfigSchema.parse(parsed);
  }
  const guidance = await optionalRegularFile(root, config.guidance.path, 32 * 1_024) ?? "";
  if (redact(guidance) !== guidance) throw new Error("Repository guidance contains secret-like content and was not loaded");
  return {
    path: config.guidance.path,
    content: guidance,
    hash: createHash("sha256").update(guidance).digest("hex"),
    version: config.guidance.version,
    config,
  };
}
