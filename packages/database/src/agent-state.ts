import { and, eq, sql } from "drizzle-orm";

import type { Database } from "./client.js";
import {
  outboxEvents,
  runApprovals,
  runClarifications,
  runContextItems,
  runEvents,
  runInspectorQueries,
  runPlans,
  runs,
  runTaskBriefs,
} from "./schema.js";

export interface SavedRunPlan {
  suspectedCause: string;
  evidenceReferences: string[];
  intendedFiles: string[];
  scopeExclusions: string[];
  verificationSteps: string[];
}

export interface ContextProvenanceItem {
  kind: string;
  source: string;
  reference: string;
  contentHash?: string | null;
  content?: string | null;
  byteCount: number;
  selected: boolean;
  note?: string | null;
}

function strings(values: string[], maximum: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .slice(0, maximum).map((value) => value.slice(0, 1_000));
}

export async function saveRunPlan(
  db: Database,
  runId: string,
  plan: SavedRunPlan,
): Promise<void> {
  const safe = {
    suspectedCause: plan.suspectedCause.trim().slice(0, 4_000) || "Cause not yet established",
    evidenceReferences: strings(plan.evidenceReferences, 50),
    intendedFiles: strings(plan.intendedFiles, 20),
    scopeExclusions: strings(plan.scopeExclusions, 20),
    verificationSteps: strings(plan.verificationSteps, 20),
    updatedAt: new Date(),
  };
  await db.transaction(async (tx) => {
    const [existing] = await tx.select({ version: runPlans.version })
      .from(runPlans).where(eq(runPlans.runId, runId)).for("update");
    await tx.insert(runPlans).values({ runId, ...safe })
      .onConflictDoUpdate({
        target: runPlans.runId,
        set: { ...safe, version: sql`${runPlans.version} + 1` },
      });
    await tx.insert(runEvents).values({
      runId,
      kind: "plan.saved",
      message: `Saved investigation plan version ${(existing?.version ?? 0) + 1}: ${safe.intendedFiles.length} intended file(s), ${safe.verificationSteps.length} verification step(s)`,
    });
  });
}

export async function recordContextProvenance(
  db: Database,
  runId: string,
  attemptIteration: number,
  items: ContextProvenanceItem[],
): Promise<void> {
  if (items.length > 1_000) throw new Error("Context provenance item limit exceeded");
  if (items.length === 0) return;
  await db.insert(runContextItems).values(items.map((item) => ({
    runId,
    attemptIteration,
    kind: item.kind.slice(0, 40),
    source: item.source.slice(0, 40),
    reference: item.reference.slice(0, 1_000),
    contentHash: item.contentHash ?? null,
    content: item.selected ? item.content?.slice(0, 64 * 1024) ?? null : null,
    byteCount: Math.max(0, Math.min(item.byteCount, 32 * 1024 * 1024)),
    selected: item.selected,
    note: item.note?.slice(0, 2_000) ?? null,
  }))).onConflictDoNothing();
}

export async function sealTaskBriefSnapshot(db: Database, input: {
  runId: string;
  commitSha: string;
  guidance?: {
    path: string;
    hash: string;
    version: string;
    content: string;
    config: Record<string, unknown>;
  } | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [brief] = await tx.select().from(runTaskBriefs)
      .where(eq(runTaskBriefs.runId, input.runId)).for("update");
    if (!brief) throw new Error("Run task brief is missing");
    if (brief.capturedCommitSha && brief.capturedCommitSha !== input.commitSha) {
      throw new Error("Task brief is already sealed to a different commit");
    }
    if (brief.sealedAt) return;
    await tx.update(runTaskBriefs).set({
      capturedCommitSha: input.commitSha,
      guidancePath: input.guidance?.path ?? null,
      guidanceHash: input.guidance?.hash ?? null,
      guidanceVersion: input.guidance?.version ?? null,
      guidanceContent: input.guidance?.content ?? null,
      repositoryConfig: input.guidance?.config ?? null,
      sealedAt: new Date(),
    }).where(eq(runTaskBriefs.runId, input.runId));
  });
}

export async function answerClarificationAsOperator(
  db: Database,
  runId: string,
  answer: string,
): Promise<boolean> {
  const safeAnswer = answer.trim().slice(0, 4_000);
  if (!safeAnswer) return false;
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
    const [clarification] = await tx.select().from(runClarifications).where(and(
      eq(runClarifications.runId, runId), eq(runClarifications.status, "OPEN"),
    )).limit(1).for("update");
    if (!run || run.status !== "AWAITING_CLARIFICATION" || !clarification || clarification.deadlineAt <= new Date()) return false;
    const now = new Date();
    await tx.update(runClarifications).set({
      status: "ANSWERED", answer: safeAnswer, answeredBy: "local-operator", answeredAt: now,
    }).where(eq(runClarifications.id, clarification.id));
    await tx.update(runs).set({
      status: "DIAGNOSING", statusReason: "Operator clarification received; resuming from the saved checkpoint",
      failureClassification: null, updatedAt: now, version: sql`${runs.version} + 1`,
    }).where(eq(runs.id, runId));
    await tx.insert(runEvents).values({ runId, kind: "clarification.answered", message: "Clarification answered through the authenticated local control center" });
    await tx.insert(outboxEvents).values({ aggregateType: "run", aggregateId: runId, eventType: "run.followup.requested", payload: { runId, mode: run.mode } });
    return true;
  });
}

export async function saveInspectorAnswer(db: Database, input: {
  runId: string;
  question: string;
  answer: string;
  evidenceReferences: string[];
  status: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
}) {
  const [saved] = await db.insert(runInspectorQueries).values({
    runId: input.runId,
    question: input.question.slice(0, 2_000),
    answer: input.answer.slice(0, 8_000),
    evidenceReferences: strings(input.evidenceReferences, 50),
    status: input.status.slice(0, 30),
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
  }).returning();
  return saved!;
}

function safeApprovedPath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !path.startsWith("/") &&
    !path.includes("\\") && !path.includes("*") &&
    path.split("/").every((part) => Boolean(part) && part !== "." && part !== ".." && !part.startsWith("."));
}

export async function approveScopeExpansion(db: Database, input: {
  runId: string;
  paths: string[];
  reason: string;
  approvedBy?: string;
  confirmed: boolean;
}): Promise<boolean> {
  const paths = strings(input.paths, 20);
  if (!input.confirmed || paths.length === 0 || paths.some((path) => !safeApprovedPath(path))) return false;
  const reason = input.reason.trim().slice(0, 2_000);
  if (!reason) return false;
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId)).for("update");
    if (!run || ["SUCCEEDED", "CANCELLED", "REJECTED"].includes(run.status)) return false;
    await tx.insert(runApprovals).values({
      runId: input.runId,
      kind: "SCOPE_EXPANSION",
      paths,
      reason,
      approvedBy: input.approvedBy ?? "local-operator",
    });
    await tx.insert(runEvents).values({
      runId: input.runId,
      kind: "scope.expanded",
      message: `Authenticated operator approved ${paths.length} additional path(s): ${paths.join(", ")}`,
    });
    if (run.status === "NEEDS_HUMAN") {
      await tx.update(runs).set({
        status: "DIAGNOSING",
        statusReason: "Approved scope expansion recorded; resuming with remaining budgets",
        failureClassification: null,
        updatedAt: new Date(),
        version: sql`${runs.version} + 1`,
      }).where(eq(runs.id, input.runId));
      await tx.insert(outboxEvents).values({ aggregateType: "run", aggregateId: input.runId, eventType: "run.followup.requested", payload: { runId: input.runId, mode: run.mode } });
    }
    return true;
  });
}
