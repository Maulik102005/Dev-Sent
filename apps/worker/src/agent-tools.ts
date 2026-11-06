import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { editablePath, proposalSchema, redact, type RepairProposal, type SourceFile } from "./repair-policy.js";
import { safeRepositoryPath, type RepositoryAgentConfig } from "./repository-guidance.js";
import { regressionTestProposalSchema, validateRegressionTestProposal, type RegressionTestProposal } from "./regression-policy.js";

export type AgentPhase = "INVESTIGATE" | "PLAN" | "PATCH";
export type AgentToolName = "list_files" | "search_code" | "read_text" | "request_test" | "submit_plan" | "request_clarification" | "propose_regression_test" | "propose_patch";

export interface AgentPlan {
  suspectedCause: string;
  evidenceReferences: string[];
  intendedFiles: string[];
  scopeExclusions: string[];
  verificationSteps: string[];
}

export interface AgentToolTrace {
  sequence: number;
  phase: AgentPhase;
  tool: AgentToolName;
  summary: string;
  outputBytes: number;
}

export interface AgentToolBudget {
  maxCalls: number;
  maxOutputBytes: number;
  deadlineMs: number;
}

const listSchema = z.object({ query: z.string().max(120).optional(), pathPrefix: z.string().max(240).optional() }).strict();
const searchSchema = z.object({ query: z.string().min(2).max(120), pathPrefix: z.string().max(240).optional(), maxResults: z.number().int().min(1).max(50).default(20) }).strict();
const readSchema = z.object({ path: z.string().max(240), startLine: z.number().int().min(1).default(1), endLine: z.number().int().min(1).max(2_000).default(200) }).strict();
const testSchema = z.object({ profile: z.string().max(40) }).strict();
const planSchema = z.object({
  suspectedCause: z.string().min(1).max(4_000),
  evidenceReferences: z.array(z.string().min(1).max(1_000)).max(50),
  intendedFiles: z.array(z.string().min(1).max(240)).max(20),
  scopeExclusions: z.array(z.string().min(1).max(1_000)).max(20),
  verificationSteps: z.array(z.string().min(1).max(1_000)).min(1).max(20),
}).strict();
const clarificationSchema = z.object({ question: z.string().min(1).max(2_000) }).strict();

const toolSchemas: Record<AgentToolName, z.ZodType> = {
  list_files: listSchema,
  search_code: searchSchema,
  read_text: readSchema,
  request_test: testSchema,
  submit_plan: planSchema,
  request_clarification: clarificationSchema,
  propose_regression_test: regressionTestProposalSchema,
  propose_patch: proposalSchema,
};

const phaseTools: Record<AgentPhase, readonly AgentToolName[]> = {
  INVESTIGATE: ["list_files", "search_code", "read_text", "request_test", "submit_plan", "request_clarification"],
  PLAN: ["search_code", "read_text", "request_test", "submit_plan", "request_clarification"],
  PATCH: ["read_text", "propose_regression_test", "propose_patch", "request_clarification"],
};

const visibleExtension = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|txt|ya?ml)$/i;
const protectedName = /(^|\/)(?:\.env|\.git|\.secrets?|node_modules|dist|build|coverage)(\/|$)|(?:^|\/)(?:id_rsa|id_ed25519|credentials)(?:\.|$)/i;

interface IndexedFile {
  path: string;
  bytes: number;
  editable: boolean;
  content?: string;
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function jsonSchema(name: AgentToolName): Record<string, unknown> {
  const definitions: Record<AgentToolName, Record<string, unknown>> = {
    list_files: { type: "object", additionalProperties: false, properties: { query: { type: "string" }, pathPrefix: { type: "string" } } },
    search_code: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string" }, pathPrefix: { type: "string" }, maxResults: { type: "integer", minimum: 1, maximum: 50 } } },
    read_text: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1, maximum: 2000 } } },
    request_test: { type: "object", additionalProperties: false, required: ["profile"], properties: { profile: { type: "string" } } },
    submit_plan: { type: "object", additionalProperties: false, required: ["suspectedCause", "evidenceReferences", "intendedFiles", "scopeExclusions", "verificationSteps"], properties: { suspectedCause: { type: "string" }, evidenceReferences: { type: "array", items: { type: "string" } }, intendedFiles: { type: "array", items: { type: "string" } }, scopeExclusions: { type: "array", items: { type: "string" } }, verificationSteps: { type: "array", items: { type: "string" } } } },
    request_clarification: { type: "object", additionalProperties: false, required: ["question"], properties: { question: { type: "string" } } },
    propose_regression_test: { type: "object", additionalProperties: false, required: ["summary", "path", "content"], properties: { summary: { type: "string" }, path: { type: "string" }, content: { type: "string" } } },
    propose_patch: { type: "object", additionalProperties: false, required: ["summary", "edits"], properties: { summary: { type: "string" }, edits: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } } } },
  };
  return definitions[name];
}

export function modelToolDefinitions(phase?: AgentPhase): Array<Record<string, unknown>> {
  const names = phase ? phaseTools[phase] : Object.keys(toolSchemas) as AgentToolName[];
  return names.map((name) => ({
    type: "function",
    name,
    description: {
      list_files: "List bounded repository text files. Investigation phase only.",
      search_code: "Search bounded repository text for a literal string.",
      read_text: "Read a bounded line range from one repository text file.",
      request_test: "Request an application-approved test profile; this never selects a host command.",
      submit_plan: "Persist the concise investigation plan before proposing a patch.",
      request_clarification: "Pause with one specific question when required evidence or intent is missing.",
      propose_regression_test: "Propose one new audited regression test when the unchanged suite does not reproduce the issue.",
      propose_patch: "Submit complete replacement contents for a bounded source-only patch.",
    }[name],
    // Application-side Zod schemas are authoritative. Non-strict provider
    // schemas allow optional arguments while the application still rejects
    // unknown fields, unsafe paths, and out-of-phase tools.
    strict: false,
    parameters: jsonSchema(name),
  }));
}

export class AgentToolSession {
  private phaseValue: AgentPhase = "INVESTIGATE";
  private callsValue = 0;
  private outputBytesValue = 0;
  private readonly traceValue: AgentToolTrace[] = [];
  private files: IndexedFile[] | null = null;
  plan: AgentPlan | null = null;
  proposal: RepairProposal | null = null;
  regressionTest: (RegressionTestProposal & { hash: string }) | null = null;
  clarificationQuestion: string | null = null;

  constructor(private readonly options: {
    root: string;
    config: RepositoryAgentConfig;
    approvedPaths: string[];
    excludedPaths: string[];
    allowRegressionTests: boolean;
    budget: AgentToolBudget;
  }) {
    if (!Number.isInteger(options.budget.maxCalls) || options.budget.maxCalls < 1 || options.budget.maxCalls > 100) throw new Error("Invalid agent tool call budget");
    if (!Number.isInteger(options.budget.maxOutputBytes) || options.budget.maxOutputBytes < 1 || options.budget.maxOutputBytes > 2 * 1024 * 1024) throw new Error("Invalid agent tool output budget");
  }

  get phase() { return this.phaseValue; }
  get calls() { return this.callsValue; }
  get outputBytes() { return this.outputBytesValue; }
  get trace() { return [...this.traceValue]; }

  private permitted(path: string): boolean {
    return safeRepositoryPath(path) && visibleExtension.test(path) && !protectedName.test(path);
  }

  private canEdit(path: string): boolean {
    if (!editablePath(path)) return false;
    if (!this.options.config.supportedSourcePaths.some((prefix) => under(path, prefix))) return false;
    if (this.options.approvedPaths.length > 0 && !this.options.approvedPaths.some((prefix) => under(path, prefix))) return false;
    const excluded = [...this.options.config.excludedPaths, ...this.options.excludedPaths];
    return !excluded.some((prefix) => under(path, prefix));
  }

  private async index(): Promise<IndexedFile[]> {
    if (this.files) return this.files;
    const files: IndexedFile[] = [];
    let entries = 0;
    let totalBytes = 0;
    const visit = async (directory: string, prefix: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (++entries > 20_000) throw new Error("Repository investigation entry limit exceeded");
        if (child.name.startsWith(".") || ["node_modules", "dist", "build", "coverage"].includes(child.name)) continue;
        const path = prefix ? `${prefix}/${child.name}` : child.name;
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory()) {
          if (path.split("/").length < 10) await visit(join(directory, child.name), path);
          continue;
        }
        if (!child.isFile() || !this.permitted(path)) continue;
        const info = await lstat(join(this.options.root, path));
        if (info.size > 64 * 1_024 || info.nlink !== 1) continue;
        totalBytes += info.size;
        if (totalBytes > 32 * 1024 * 1024) throw new Error("Repository investigation byte limit exceeded");
        files.push({ path, bytes: info.size, editable: this.canEdit(path) && (info.mode & 0o111) === 0 });
      }
    };
    await visit(this.options.root, "");
    this.files = files;
    return files;
  }

  private async content(file: IndexedFile): Promise<string> {
    if (file.content !== undefined) return file.content;
    const value = await readFile(join(this.options.root, file.path), "utf8");
    if (value.includes("\0") || redact(value) !== value) throw new Error("File contains binary or secret-like content and cannot be read");
    file.content = value;
    return value;
  }

  async sourceCatalog(): Promise<SourceFile[]> {
    const values: SourceFile[] = [];
    for (const file of await this.index()) {
      if (!file.editable) continue;
      try { values.push({ path: file.path, content: await this.content(file), editable: true }); }
      catch { values.push({ path: file.path, content: "", editable: false }); }
    }
    return values;
  }

  async execute(name: string, rawArguments: unknown): Promise<unknown> {
    if (!(name in toolSchemas)) throw new Error("Unknown agent tool");
    const tool = name as AgentToolName;
    if (!phaseTools[this.phaseValue].includes(tool)) throw new Error(`${tool} is not available during ${this.phaseValue}`);
    if (Date.now() >= this.options.budget.deadlineMs) throw new Error("Agent tool deadline exhausted");
    if (this.callsValue >= this.options.budget.maxCalls) throw new Error("Agent tool call budget exhausted");
    this.callsValue += 1;
    const args = toolSchemas[tool].parse(rawArguments) as any;
    const phase = this.phaseValue;
    let result: unknown;
    let summary = "completed";
    if (tool === "list_files") {
      const query = args.query?.toLowerCase();
      const prefix = args.pathPrefix;
      if (prefix && !safeRepositoryPath(prefix)) throw new Error("Unsafe path prefix");
      const matches = (await this.index()).filter((file) => (!prefix || under(file.path, prefix)) && (!query || file.path.toLowerCase().includes(query))).slice(0, 200);
      result = { files: matches.map(({ path, bytes, editable }) => ({ path, bytes, editable })), truncated: matches.length === 200 };
      summary = `listed ${matches.length} file(s)`;
    } else if (tool === "search_code") {
      const prefix = args.pathPrefix;
      if (prefix && !safeRepositoryPath(prefix)) throw new Error("Unsafe path prefix");
      const hits: Array<{ reference: string; text: string }> = [];
      for (const file of await this.index()) {
        if (prefix && !under(file.path, prefix)) continue;
        let content: string;
        try { content = await this.content(file); } catch { continue; }
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          if (lines[index]!.toLowerCase().includes(args.query.toLowerCase())) {
            hits.push({ reference: `${file.path}:${index + 1}`, text: redact(lines[index]!).slice(0, 500) });
            if (hits.length >= args.maxResults) break;
          }
        }
        if (hits.length >= args.maxResults) break;
      }
      result = { hits, truncated: hits.length >= args.maxResults };
      summary = `found ${hits.length} result(s)`;
    } else if (tool === "read_text") {
      if (!this.permitted(args.path) || args.endLine < args.startLine || args.endLine - args.startLine + 1 > 200) throw new Error("Unsafe or oversized text range");
      const file = (await this.index()).find((value) => value.path === args.path);
      if (!file) throw new Error("File is not available to the agent");
      const lines = (await this.content(file)).split(/\r?\n/);
      const text = lines.slice(args.startLine - 1, args.endLine).map((line, index) => `${args.startLine + index}: ${line}`).join("\n").slice(0, 16 * 1_024);
      result = { reference: `${file.path}:${args.startLine}-${Math.min(args.endLine, lines.length)}`, text };
      summary = `read ${file.path}`;
    } else if (tool === "request_test") {
      const profile = args.profile === "full-suite" ? { name: "full-suite", relevantPaths: [], runner: "package-test" } : this.options.config.testProfiles.find((value) => value.name === args.profile);
      if (!profile) throw new Error("Unknown or unapproved test profile");
      result = { approved: true, profile: profile.name, runner: "package-test", note: "The application selects the locked package test command and executes it in the sandbox." };
      summary = `requested ${profile.name}`;
    } else if (tool === "submit_plan") {
      for (const path of args.intendedFiles) if (!this.canEdit(path)) throw new Error(`Plan includes out-of-scope file: ${path}`);
      this.plan = args;
      this.phaseValue = "PATCH";
      result = { accepted: true, nextPhase: "PATCH" };
      summary = `submitted plan for ${args.intendedFiles.length} file(s)`;
    } else if (tool === "request_clarification") {
      this.clarificationQuestion = args.question.trim();
      result = { accepted: true, paused: true };
      summary = "requested clarification";
    } else if (tool === "propose_regression_test") {
      if (!this.options.allowRegressionTests || !this.options.config.regressionTests.enabled) throw new Error("Audited regression test proposals are not enabled by both platform and repository policy");
      const proposal = validateRegressionTestProposal(args, this.options.config.regressionTests.allowedPaths);
      if ((await this.index()).some((file) => file.path === proposal.path)) throw new Error("Regression reproducer cannot replace an existing file");
      this.regressionTest = proposal;
      result = { accepted: true, frozenHash: proposal.hash, path: proposal.path, note: "The application must still prove failure on the untouched source before applying a repair." };
      summary = `proposed audited reproducer ${proposal.path}`;
    } else {
      if (!this.plan) throw new Error("A saved plan is required before proposing a patch");
      const proposal = proposalSchema.parse(args);
      const catalog = await this.sourceCatalog();
      for (const edit of proposal.edits) {
        const file = catalog.find((value) => value.path === edit.path);
        if (!file?.editable) throw new Error(`Patch includes protected or out-of-scope file: ${edit.path}`);
      }
      this.proposal = proposal;
      result = { accepted: true, editCount: proposal.edits.length };
      summary = `proposed ${proposal.edits.length} edit(s)`;
    }
    const output = JSON.stringify(result);
    const bytes = Buffer.byteLength(output);
    if (this.outputBytesValue + bytes > this.options.budget.maxOutputBytes) throw new Error("Agent tool output budget exhausted");
    this.outputBytesValue += bytes;
    this.traceValue.push({ sequence: this.callsValue, phase, tool, summary, outputBytes: bytes });
    return result;
  }

  async seedContext(task: string, maximumBytes: number): Promise<{ files: SourceFile[]; provenance: Array<{ kind: string; source: string; reference: string; contentHash: string; content: string | null; byteCount: number; selected: boolean; note: string }> }> {
    const tokens = [...new Set(task.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [])]
      .filter((token) => !["the", "and", "for", "with", "this", "that", "from", "issue", "fix"].includes(token)).slice(0, 30);
    const scored: Array<{ file: IndexedFile; content: string; score: number }> = [];
    for (const file of await this.index()) {
      let content: string;
      try { content = await this.content(file); } catch { continue; }
      const haystack = `${file.path}\n${content}`.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 4 : 0), 0) +
        (file.editable ? 2 : 0) + (/\.(test|spec)\./i.test(file.path) || /(^|\/)test(s)?\//i.test(file.path) ? 3 : 0) +
        (/README|DEVSENTINEL/i.test(file.path) ? 1 : 0);
      scored.push({ file, content, score });
    }
    scored.sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
    const selected: SourceFile[] = [];
    const provenance: Array<{ kind: string; source: string; reference: string; contentHash: string; content: string | null; byteCount: number; selected: boolean; note: string }> = [];
    let bytes = 0;
    // Leave room for up to 50 bounded GitHub discussion records in the
    // database's 1,000-item per-attempt provenance ceiling.
    const recorded = scored.slice(0, 949);
    for (const item of recorded) {
      const size = Buffer.byteLength(item.content);
      const choose = selected.length < 80 && bytes + size <= maximumBytes && (item.score > 0 || selected.length < 8);
      if (choose) {
        selected.push({ path: item.file.path, content: item.content, editable: item.file.editable });
        bytes += size;
      }
      provenance.push({
        kind: item.file.editable ? "source" : "evidence",
        source: "captured-revision",
        reference: item.file.path,
        contentHash: createHash("sha256").update(item.content).digest("hex"),
        content: choose ? item.content : null,
        byteCount: size,
        selected: choose,
        note: choose ? `selected by bounded relevance score ${item.score}` : "omitted by relevance or context byte budget",
      });
    }
    if (scored.length > recorded.length) {
      const omitted = scored.slice(recorded.length);
      provenance.push({
        kind: "omission",
        source: "captured-revision",
        reference: `context-provenance-limit:${omitted.length}-files`,
        contentHash: createHash("sha256").update(omitted.map((item) => item.file.path).join("\n")).digest("hex"),
        content: null,
        byteCount: omitted.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0),
        selected: false,
        note: "Additional bounded text files were omitted from per-file provenance after relevance ordering",
      });
    }
    return { files: selected, provenance };
  }
}
