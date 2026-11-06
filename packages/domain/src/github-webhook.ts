import { z } from "zod";

import type { RunMode } from "./run.js";

const installationSchema = z.object({
  id: z.number().int().positive(),
});

const repositorySchema = z.object({
  id: z.number().int().positive(),
  full_name: z.string().min(3),
  default_branch: z.string().min(1),
});

const senderSchema = z.object({
  login: z.string().min(1),
});

const issueSchema = z.object({
  id: z.number().int().positive().optional(),
  number: z.number().int().positive(),
  title: z.string().max(2_000).optional().nullable(),
  body: z.string().max(100_000).optional().nullable(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  pull_request: z.unknown().optional(),
});

export const githubIssueLabelPayloadSchema = z.object({
  action: z.literal("labeled"),
  installation: installationSchema,
  repository: repositorySchema,
  sender: senderSchema,
  issue: issueSchema,
  label: z.object({
    name: z.string(),
  }),
});

export const githubIssueCommentPayloadSchema = z.object({
  action: z.literal("created"),
  installation: installationSchema,
  repository: repositorySchema,
  sender: senderSchema,
  issue: issueSchema,
  comment: z.object({
    id: z.number().int().positive().optional(),
    body: z.string(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  }),
});

export interface ParsedCommandContext {
  raw: string;
  requestedOutcome: string;
  acceptanceCriteria: string[];
  constraints: string[];
  approvedPaths: string[];
  excludedPaths: string[];
}

export interface GitHubRunTrigger {
  installationId: number;
  repositoryId: number;
  repositoryFullName: string;
  defaultBranch: string;
  issueNumber: number;
  actorLogin: string;
  activation: "label" | "command";
  mode: RunMode;
  issueTitle?: string;
  issueBody?: string;
  issueId?: string;
  issueCreatedAt?: string;
  issueUpdatedAt?: string;
  triggerComment?: string;
  triggerCommentId?: string;
  triggerCommentCreatedAt?: string;
  commandContext?: ParsedCommandContext;
}

export interface GitHubRunContinuation {
  runId: string;
  answer: string;
  actorLogin: string;
  repositoryId: number;
  repositoryFullName: string;
  issueNumber: number;
  deliveryCommentId: string | null;
  createdAt: string | null;
}

function modeFromLabel(label: string): RunMode | null {
  if (label === "devsentinel:test") {
    return "TEST";
  }

  if (label === "devsentinel:fix") {
    return "FIX";
  }

  return null;
}

function modeFromCommand(command: string): RunMode | null {
  const match = /^\/devsentinel[ \t]+(test|fix)(?:[ \t]|\r?\n|$)/i.exec(command.trim());

  if (!match?.[1]) {
    return null;
  }

  return match[1].toUpperCase() as RunMode;
}

function boundedUnique(values: string[], maximum = 20): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .slice(0, maximum)
    .map((value) => value.slice(0, 1_000));
}

function safeScopePath(value: string): boolean {
  return value.length <= 240 && !value.startsWith("/") &&
    !value.includes("\\") && !value.includes("*") &&
    value.split("/").every((part) => Boolean(part) && part !== "." && part !== ".." && !part.startsWith("."));
}

export function parseCommandContext(body: string): ParsedCommandContext | null {
  const trimmed = body.trim();
  const match = /^\/devsentinel[ \t]+(test|fix)(?:[ \t]+([^\r\n]*))?(?:\r?\n([\s\S]*))?$/i.exec(trimmed);
  if (!match) return null;
  const sameLine = match[2]?.trim() ?? "";
  const remainder = match[3]?.trim() ?? "";
  const lines = remainder.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const prefixed = (name: string) => lines
    .filter((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    .map((line) => line.slice(name.length + 1).trim());
  const pathValues = (name: string) => prefixed(name).flatMap((line) => line.split(","))
    .map((value) => value.trim()).filter(safeScopePath);
  const unstructured = lines.filter((line) => !/^(outcome|acceptance|constraint|scope|exclude):/i.test(line));
  return {
    raw: [sameLine, remainder].filter(Boolean).join("\n").slice(0, 16_000),
    requestedOutcome: (prefixed("outcome")[0] ?? sameLine ?? "").slice(0, 4_000),
    acceptanceCriteria: boundedUnique(prefixed("acceptance")),
    constraints: boundedUnique([...prefixed("constraint"), ...unstructured]),
    approvedPaths: boundedUnique(pathValues("scope")),
    excludedPaths: boundedUnique(pathValues("exclude")),
  };
}

function issueFields(issue: z.infer<typeof issueSchema>) {
  return {
    issueTitle: issue.title ?? "",
    issueBody: issue.body ?? "",
    ...(issue.id ? { issueId: String(issue.id) } : {}),
    ...(issue.created_at ? { issueCreatedAt: issue.created_at } : {}),
    ...(issue.updated_at ? { issueUpdatedAt: issue.updated_at } : {}),
  };
}

function commonTriggerFields(
  payload: {
    installation: { id: number };
    repository: {
      id: number;
      full_name: string;
      default_branch: string;
    };
    sender: { login: string };
    issue: { number: number };
  },
): Omit<GitHubRunTrigger, "activation" | "mode"> {
  return {
    installationId: payload.installation.id,
    repositoryId: payload.repository.id,
    repositoryFullName: payload.repository.full_name,
    defaultBranch: payload.repository.default_branch,
    issueNumber: payload.issue.number,
    actorLogin: payload.sender.login,
  };
}

export function extractRunTrigger(
  eventName: string,
  payload: unknown,
): GitHubRunTrigger | null {
  if (eventName === "issues") {
    const parsed = githubIssueLabelPayloadSchema.safeParse(payload);

    if (!parsed.success || parsed.data.issue.pull_request !== undefined) {
      return null;
    }

    const mode = modeFromLabel(parsed.data.label.name);

    if (!mode) {
      return null;
    }

    return {
      ...commonTriggerFields(parsed.data),
      ...issueFields(parsed.data.issue),
      activation: "label",
      mode,
    };
  }

  if (eventName === "issue_comment") {
    const parsed = githubIssueCommentPayloadSchema.safeParse(payload);

    if (!parsed.success || parsed.data.issue.pull_request !== undefined) {
      return null;
    }

    const mode = modeFromCommand(parsed.data.comment.body);

    if (!mode) {
      return null;
    }

    return {
      ...commonTriggerFields(parsed.data),
      ...issueFields(parsed.data.issue),
      activation: "command",
      mode,
      triggerComment: parsed.data.comment.body,
      ...(parsed.data.comment.id ? { triggerCommentId: String(parsed.data.comment.id) } : {}),
      ...(parsed.data.comment.created_at ? { triggerCommentCreatedAt: parsed.data.comment.created_at } : {}),
      ...(parseCommandContext(parsed.data.comment.body)
        ? { commandContext: parseCommandContext(parsed.data.comment.body)! }
        : {}),
    };
  }

  return null;
}

export function extractRunContinuation(
  eventName: string,
  payload: unknown,
): GitHubRunContinuation | null {
  if (eventName !== "issue_comment") return null;
  const parsed = githubIssueCommentPayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.issue.pull_request !== undefined) return null;
  const match = /^\/devsentinel[ \t]+continue[ \t]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[ \t]+([^\r\n]+)|\r?\n([\s\S]+))$/i.exec(parsed.data.comment.body.trim());
  const answer = (match?.[2] ?? match?.[3] ?? "").trim();
  if (!match?.[1] || answer.length < 1 || answer.length > 4_000) return null;
  return {
    runId: match[1].toLowerCase(),
    answer,
    actorLogin: parsed.data.sender.login,
    repositoryId: parsed.data.repository.id,
    repositoryFullName: parsed.data.repository.full_name,
    issueNumber: parsed.data.issue.number,
    deliveryCommentId: parsed.data.comment.id ? String(parsed.data.comment.id) : null,
    createdAt: parsed.data.comment.created_at ?? null,
  };
}
