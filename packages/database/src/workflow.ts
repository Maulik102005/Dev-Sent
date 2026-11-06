import { isTerminalRunStatus, type RunFailureClassification, type RunStatus } from "@devsentinel/domain";
import { and, asc, count, desc, eq, gt, ilike, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { outboxEvents, repairAttempts, runApprovals, runClarifications, runContextItems, runEvents, runInspectorQueries, runPlans, runs, runTaskBriefs, runWorkflows, sandboxExecutions, webhookDeliveries } from "./schema.js";

export async function getRunDetail(db: Database, runId: string) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return null;
  const [workflow] = await db.select().from(runWorkflows).where(eq(runWorkflows.runId, runId));
  const [taskBrief] = await db.select().from(runTaskBriefs).where(eq(runTaskBriefs.runId, runId));
  const [plan] = await db.select().from(runPlans).where(eq(runPlans.runId, runId));
  const attempts = await db.select().from(repairAttempts).where(eq(repairAttempts.runId, runId)).orderBy(asc(repairAttempts.iteration));
  const executions = await db.select().from(sandboxExecutions).where(eq(sandboxExecutions.runId, runId));
  const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.createdAt)).limit(500);
  const clarifications = await db.select().from(runClarifications).where(eq(runClarifications.runId, runId)).orderBy(asc(runClarifications.requestedAt)).limit(50);
  const context = await db.select().from(runContextItems).where(eq(runContextItems.runId, runId)).orderBy(asc(runContextItems.createdAt)).limit(1000);
  const inspector = await db.select().from(runInspectorQueries).where(eq(runInspectorQueries.runId, runId)).orderBy(asc(runInspectorQueries.createdAt)).limit(100);
  const approvals = await db.select().from(runApprovals).where(eq(runApprovals.runId, runId)).orderBy(asc(runApprovals.createdAt)).limit(100);
  const outbox = await db.select({ id: outboxEvents.id, eventType: outboxEvents.eventType, attempts: outboxEvents.attempts, lastError: outboxEvents.lastError, publishedAt: outboxEvents.publishedAt, deadLetteredAt: outboxEvents.deadLetteredAt }).from(outboxEvents).where(eq(outboxEvents.aggregateId, runId)).limit(100);
  return { run, workflow: workflow ?? null, taskBrief: taskBrief ?? null, plan: plan ?? null, attempts, executions, events, clarifications, context, inspector, approvals, outbox };
}

export async function getTriggerIssue(db: Database, runId: string): Promise<string> {
  const [brief] = await db.select().from(runTaskBriefs).where(eq(runTaskBriefs.runId, runId));
  if (brief) return [brief.issueTitle, brief.issueBody, brief.commandContext]
    .filter(Boolean).join("\n").slice(0, 16_000);
  const [row] = await db.select({ payload: webhookDeliveries.payload }).from(runs)
    .innerJoin(webhookDeliveries, eq(webhookDeliveries.id, runs.triggerDeliveryId)).where(eq(runs.id, runId));
  const payload = row?.payload as { issue?: { title?: unknown; body?: unknown } } | undefined;
  return [payload?.issue?.title, payload?.issue?.body].filter((v) => typeof v === "string").join("\n").slice(0, 8_000);
}

export async function getAgentTaskContext(db: Database, runId: string) {
  const [brief] = await db.select().from(runTaskBriefs).where(eq(runTaskBriefs.runId, runId));
  const clarifications = await db.select({
    question: runClarifications.question,
    answer: runClarifications.answer,
    answeredBy: runClarifications.answeredBy,
    answeredAt: runClarifications.answeredAt,
  }).from(runClarifications).where(and(
    eq(runClarifications.runId, runId),
    eq(runClarifications.status, "ANSWERED"),
  )).orderBy(asc(runClarifications.requestedAt));
  return { brief: brief ?? null, clarifications };
}

export async function claimWorkflow(db: Database, runId: string, owner: string, leaseMs = 60000): Promise<boolean> {
  await db.insert(runWorkflows).values({ runId }).onConflictDoNothing();
  const [claimed] = await db.update(runWorkflows).set({ leaseOwner: owner, leaseUntil: new Date(Date.now() + leaseMs) })
    .where(and(eq(runWorkflows.runId, runId), or(isNull(runWorkflows.leaseUntil), lt(runWorkflows.leaseUntil, new Date()))))
    .returning({ id: runWorkflows.runId });
  return Boolean(claimed);
}

export async function renewWorkflow(db: Database, runId: string, owner: string): Promise<boolean> {
  const [row] = await db.update(runWorkflows).set({ leaseUntil: new Date(Date.now() + 60000) })
    .where(and(eq(runWorkflows.runId, runId), eq(runWorkflows.leaseOwner, owner), gt(runWorkflows.leaseUntil, new Date())))
    .returning({ id: runWorkflows.runId });
  return Boolean(row);
}

export async function releaseWorkflow(db: Database, runId: string, owner: string): Promise<void> {
  await db.update(runWorkflows).set({ leaseOwner: null, leaseUntil: null })
    .where(and(eq(runWorkflows.runId, runId), eq(runWorkflows.leaseOwner, owner)));
}

export async function assertWorkflow(db: Database, runId: string, owner: string): Promise<void> {
  const [row] = await db.select({ status: runs.status }).from(runWorkflows)
    .innerJoin(runs, eq(runs.id, runWorkflows.runId))
    .where(and(eq(runWorkflows.runId, runId), eq(runWorkflows.leaseOwner, owner), gt(runWorkflows.leaseUntil, new Date())));
  if (!row || row.status === "CANCELLED") throw new Error("Workflow cancelled or lease lost");
}

// Lock the lease row for every checkpoint: a previous worker cannot commit after takeover.
async function lockedWorkflow<T>(db: Database, runId: string, owner: string,
  action: (tx: Parameters<Parameters<Database["transaction"]>[0]>[0], workflow: typeof runWorkflows.$inferSelect, run: typeof runs.$inferSelect) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const [workflow] = await tx.select().from(runWorkflows).where(eq(runWorkflows.runId, runId)).for("update");
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
    if (!workflow || workflow.leaseOwner !== owner || !workflow.leaseUntil || workflow.leaseUntil <= new Date() || !run || run.status === "CANCELLED") throw new Error("Workflow cancelled or lease lost");
    return action(tx, workflow, run);
  });
}

export async function requestClarificationCheckpoint(
  db: Database,
  runId: string,
  owner: string,
  question: string,
  deadlineAt: Date,
): Promise<void> {
  const safeQuestion = question.trim().slice(0, 2_000);
  if (!safeQuestion) throw new Error("Clarification question is empty");
  await lockedWorkflow(db, runId, owner, async (tx) => {
    const [existing] = await tx.select({ id: runClarifications.id })
      .from(runClarifications)
      .where(and(eq(runClarifications.runId, runId), eq(runClarifications.status, "OPEN")))
      .limit(1);
    if (!existing) await tx.insert(runClarifications).values({ runId, question: safeQuestion, deadlineAt });
    await tx.update(runs).set({
      status: "AWAITING_CLARIFICATION",
      statusReason: safeQuestion,
      failureClassification: "UNCLEAR_TASK",
      updatedAt: new Date(),
      version: sql`${runs.version} + 1`,
    }).where(eq(runs.id, runId));
    await tx.insert(runEvents).values({
      runId,
      kind: "clarification.requested",
      message: `${safeQuestion} Answer with /devsentinel continue ${runId} <answer> before ${deadlineAt.toISOString()}`,
    });
  });
}

export async function checkpoint(db: Database, runId: string, owner: string, input: {
  status?: RunStatus; reason: string; kind: string;
  failureClassification?: RunFailureClassification | null;
  attemptId?: string; attempt?: Partial<typeof repairAttempts.$inferInsert>;
  delivery?: Record<string, unknown>; delivered?: boolean;
}): Promise<void> {
  await lockedWorkflow(db, runId, owner, async (tx, workflow, run) => {
    if (input.status && isTerminalRunStatus(run.status) && input.status !== run.status) throw new Error("Cannot transition a terminal run");
    await tx.update(runs).set({ ...(input.status ? { status: input.status } : {}),
      ...(input.failureClassification !== undefined ? { failureClassification: input.failureClassification } : {}),
      ...(["delivery.checkpoint", "delivery.progress-warning"].includes(input.kind) ? {} : { statusReason: input.reason.slice(0, 2000) }),
      updatedAt: new Date(), version: sql`${runs.version} + 1` }).where(eq(runs.id, runId));
    if (input.attemptId && input.attempt) {
      await tx.update(repairAttempts).set({ ...input.attempt, updatedAt: new Date() }).where(and(eq(repairAttempts.id, input.attemptId), eq(repairAttempts.runId, runId)));
    }
    if (input.delivery || input.delivered) await tx.update(runWorkflows).set({
      ...(input.delivery ? { delivery: { ...workflow.delivery, ...input.delivery } } : {}),
      ...(input.delivered ? { deliveryCompletedAt: new Date(), lastError: null } : {}),
    }).where(eq(runWorkflows.runId, runId));
    await tx.insert(runEvents).values({ runId, kind: input.kind, message: input.reason.slice(0, 4000) });
  });
}

export async function reserveAttempt(db: Database, runId: string, owner: string, budget: {
  tokens: number;
  maxTokens: number;
  maxAttempts: number;
  maxDurationMs: number;
  toolCalls?: number;
  toolOutputBytes?: number;
  maxToolCalls?: number;
  maxToolOutputBytes?: number;
}) {
  return lockedWorkflow(db, runId, owner, async (tx, workflow, run) => {
    if (isTerminalRunStatus(run.status)) return null;
    const clarificationPauses = await tx.select({
      requestedAt: runClarifications.requestedAt,
      answeredAt: runClarifications.answeredAt,
      deadlineAt: runClarifications.deadlineAt,
    }).from(runClarifications).where(eq(runClarifications.runId, runId));
    const pausedMs = clarificationPauses.reduce((total, clarification) => {
      if (!clarification.answeredAt) return total;
      const boundedAnswer = Math.min(clarification.answeredAt.getTime(), clarification.deadlineAt.getTime());
      return total + Math.max(0, boundedAnswer - clarification.requestedAt.getTime());
    }, 0);
    const activeElapsedMs = Math.max(0, Date.now() - workflow.startedAt.getTime() - pausedMs);
    const toolCalls = budget.toolCalls ?? 0;
    const toolOutputBytes = budget.toolOutputBytes ?? 0;
    if (workflow.attemptCount >= budget.maxAttempts ||
      workflow.reservedTokens + budget.tokens > budget.maxTokens ||
      workflow.toolCallCount + toolCalls > (budget.maxToolCalls ?? Number.MAX_SAFE_INTEGER) ||
      workflow.toolOutputBytes + toolOutputBytes > (budget.maxToolOutputBytes ?? Number.MAX_SAFE_INTEGER) ||
      activeElapsedMs >= budget.maxDurationMs) return null;
    const iteration = workflow.attemptCount + 1;
    // Model and tool allowances are reserved before an external call. A crash or
    // clarification never refunds them, so a resumed worker cannot buy more work.
    await tx.update(runWorkflows).set({
      attemptCount: iteration,
      reservedTokens: workflow.reservedTokens + budget.tokens,
      toolCallCount: workflow.toolCallCount + toolCalls,
      toolOutputBytes: workflow.toolOutputBytes + toolOutputBytes,
    }).where(eq(runWorkflows.runId, runId));
    const [attempt] = await tx.insert(repairAttempts).values({ runId, iteration, status: "RESERVED", reservedTokens: budget.tokens }).returning();
    await tx.insert(runEvents).values({ runId, kind: "model.reserved", message: `Attempt ${iteration}: reserved ${budget.tokens} token units before the model request` });
    return attempt!;
  });
}

export async function cancelRun(db: Database, runId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
    if (!run || isTerminalRunStatus(run.status)) return false;
    await tx.update(runs).set({ status: "CANCELLED", statusReason: "Cancelled by operator", failureClassification: "CANCELLED", updatedAt: new Date(), version: sql`${runs.version} + 1` }).where(eq(runs.id, runId));
    await tx.insert(runEvents).values({ runId, kind: "run.cancelled", message: "Cancelled by operator; in-flight operations stop at the next safe boundary" });
    return true;
  });
}

export async function listRecentRuns(db: Database) { return db.select().from(runs).orderBy(desc(runs.createdAt)).limit(100); }

export async function listRunsPage(db: Database, input: {
  limit: number;
  offset: number;
  status?: string;
  mode?: string;
  search?: string;
}) {
  const filters = [
    ...(input.status ? [sql`${runs.status}::text = ${input.status}`] : []),
    ...(input.mode ? [sql`${runs.mode}::text = ${input.mode}`] : []),
    ...(input.search ? [or(
      ilike(runs.repositoryFullName, `%${input.search}%`),
      ilike(runTaskBriefs.issueTitle, `%${input.search}%`),
      sql`${runs.id}::text ILIKE ${`%${input.search}%`}`,
    )!] : []),
  ];
  const where = filters.length ? and(...filters) : undefined;
  const items = await db.select({
    id: runs.id,
    repositoryFullName: runs.repositoryFullName,
    issueNumber: runs.issueNumber,
    mode: runs.mode,
    status: runs.status,
    failureClassification: runs.failureClassification,
    statusReason: runs.statusReason,
    targetCommitSha: runs.targetCommitSha,
    createdAt: runs.createdAt,
    updatedAt: runs.updatedAt,
    issueTitle: runTaskBriefs.issueTitle,
    delivery: runWorkflows.delivery,
    deliveryCompletedAt: runWorkflows.deliveryCompletedAt,
  }).from(runs)
    .leftJoin(runTaskBriefs, eq(runTaskBriefs.runId, runs.id))
    .leftJoin(runWorkflows, eq(runWorkflows.runId, runs.id))
    .where(where).orderBy(desc(runs.createdAt)).limit(input.limit).offset(input.offset);
  const [total] = await db.select({ value: count() }).from(runs)
    .leftJoin(runTaskBriefs, eq(runTaskBriefs.runId, runs.id)).where(where);
  return { items, total: total?.value ?? 0, limit: input.limit, offset: input.offset };
}

export async function getRunEvidencePage(db: Database, input: {
  runId: string;
  kind: "events" | "context" | "inspector";
  limit: number;
  offset: number;
}) {
  const table = input.kind === "events" ? runEvents : input.kind === "context" ? runContextItems : runInspectorQueries;
  const rows = await db.select().from(table as typeof runEvents)
    .where(eq((table as typeof runEvents).runId, input.runId))
    .orderBy(asc((table as typeof runEvents).createdAt)).limit(input.limit).offset(input.offset);
  const [total] = await db.select({ value: count() }).from(table as typeof runEvents)
    .where(eq((table as typeof runEvents).runId, input.runId));
  return { items: rows, total: total?.value ?? 0, limit: input.limit, offset: input.offset };
}

export async function getRunEventStreamBatch(db: Database, cursor?: { createdAt: Date; id: string } | null) {
  return db.select().from(runEvents).where(cursor ? or(
    gt(runEvents.createdAt, cursor.createdAt),
    and(eq(runEvents.createdAt, cursor.createdAt), gt(runEvents.id, cursor.id)),
  ) : gt(runEvents.createdAt, new Date(Date.now() - 2000)))
    .orderBy(asc(runEvents.createdAt), asc(runEvents.id)).limit(100);
}

export async function reserveInspectorBudget(db: Database, input: {
  runId: string;
  reservedTokens: number;
  maxTokens: number;
  maxQueries: number;
}): Promise<boolean> {
  if (!Number.isInteger(input.reservedTokens) || input.reservedTokens < 0) return false;
  return db.transaction(async (tx) => {
    await tx.insert(runWorkflows).values({ runId: input.runId }).onConflictDoNothing();
    const [workflow] = await tx.select().from(runWorkflows).where(eq(runWorkflows.runId, input.runId)).for("update");
    if (!workflow || workflow.inspectorQueryCount >= input.maxQueries || workflow.inspectorReservedTokens + input.reservedTokens > input.maxTokens) return false;
    await tx.update(runWorkflows).set({
      inspectorQueryCount: workflow.inspectorQueryCount + 1,
      inspectorReservedTokens: workflow.inspectorReservedTokens + input.reservedTokens,
    }).where(eq(runWorkflows.runId, input.runId));
    return true;
  });
}

export async function requestRunRecovery(db: Database, runId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Operator recovery requeues the durable state; it never resets attempt or token budgets.
    const [workflow] = await tx.select().from(runWorkflows).where(eq(runWorkflows.runId, runId)).for("update");
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
    if (!run || run.status === "CANCELLED" || run.status === "AWAITING_CLARIFICATION" || workflow?.deliveryCompletedAt || (workflow?.leaseUntil && workflow.leaseUntil > new Date())) return false;
    const [verifiedAttempt] = run.failureClassification === "VERIFIED_UNDELIVERED"
      ? await tx.select({ id: repairAttempts.id }).from(repairAttempts).where(and(
          eq(repairAttempts.runId, runId),
          eq(repairAttempts.status, "VERIFIED"),
          eq(repairAttempts.deliveryEligible, true),
        )).limit(1)
      : [];
    if (verifiedAttempt) {
      await tx.update(runs).set({
        status: "PUBLISHING",
        statusReason: "Operator requested delivery recovery for the existing verified patch",
        failureClassification: null,
        updatedAt: new Date(),
        version: sql`${runs.version} + 1`,
      }).where(eq(runs.id, runId));
    }
    const eventType = run.status === "AUTHORIZING" ? "run.authorization.requested"
      : ["PREPARING", "PROVISIONING", "BASELINING"].includes(run.status) ? "run.baseline.requested" : "run.followup.requested";
    await tx.insert(outboxEvents).values({ aggregateType: "run", aggregateId: runId, eventType, payload: { runId, mode: run.mode } });
    await tx.insert(runEvents).values({
      runId,
      kind: "run.requeued",
      message: verifiedAttempt
        ? "Operator requested delivery-only recovery for the existing verified patch; repair budgets and evidence are unchanged"
        : "Operator requested recovery from persisted state; budgets are unchanged",
    });
    return true;
  });
}

export async function recordWorkflowFailure(db: Database, runId: string, message: string): Promise<void> {
  const safe = message.slice(0, 2000);
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
    await tx.update(runWorkflows).set({ lastError: safe, leaseOwner: null, leaseUntil: null }).where(eq(runWorkflows.runId, runId));
    if (run && !isTerminalRunStatus(run.status) && run.status !== "AWAITING_CLARIFICATION") {
      const verifiedUndelivered = run.status === "PUBLISHING";
      await tx.update(runs).set({
        status: verifiedUndelivered ? "NEEDS_HUMAN" : "FAILED",
        statusReason: verifiedUndelivered
          ? `Verified patch was not delivered after infrastructure retries: ${safe}`
          : `Workflow infrastructure retries were exhausted: ${safe}`,
        failureClassification: verifiedUndelivered ? "VERIFIED_UNDELIVERED" : "TRANSIENT_INFRASTRUCTURE",
        updatedAt: new Date(),
        version: sql`${runs.version} + 1`,
      }).where(eq(runs.id, runId));
    }
    await tx.insert(runEvents).values({ runId, kind: "workflow.dead-letter", message: safe });
  });
}
