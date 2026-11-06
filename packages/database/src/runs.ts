import type { RunFailureClassification, RunMode, RunStatus } from "@devsentinel/domain";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "./client.js";
import { outboxEvents, runs, sandboxExecutions } from "./schema.js";

export interface RecordedSandboxCommandResult {
  command: readonly string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface RecordedBaselineResult {
  image: string;
  install: RecordedSandboxCommandResult;
  test: RecordedSandboxCommandResult | null;
}

export async function findRunForAuthorization(db: Database, runId: string) {
  const [run] = await db
    .select({
      id: runs.id,
      status: runs.status,
      mode: runs.mode,
      githubInstallationId: runs.githubInstallationId,
      githubRepositoryId: runs.githubRepositoryId,
      repositoryFullName: runs.repositoryFullName,
      issueNumber: runs.issueNumber,
      actorLogin: runs.actorLogin,
      authorizationReason: runs.authorizationReason,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  return run ?? null;
}

export async function completeRunAuthorization(
  db: Database,
  input: {
    runId: string;
    allowed: boolean;
    reason: string;
    checkedAt?: Date;
  },
): Promise<{ id: string; status: RunStatus } | null> {
  const nextStatus = input.allowed ? "PREPARING" : "REJECTED";
  const checkedAt = input.checkedAt ?? new Date();

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(runs)
      .set({
        status: nextStatus,
        authorizationReason: input.reason.slice(0, 2_000),
        statusReason: input.allowed ? "Actor authorization passed" : input.reason.slice(0, 2_000),
        failureClassification: input.allowed ? null : "POLICY_BLOCKED",
        authorizationCheckedAt: checkedAt,
        updatedAt: checkedAt,
        version: sql`${runs.version} + 1`,
      })
      .where(and(eq(runs.id, input.runId), eq(runs.status, "AUTHORIZING")))
      .returning({ id: runs.id, status: runs.status, mode: runs.mode });

    if (!updated) {
      return null;
    }

    if (input.allowed) {
      await tx.insert(outboxEvents).values({
        aggregateType: "run",
        aggregateId: updated.id,
        eventType: "run.baseline.requested",
        payload: { runId: updated.id, mode: updated.mode },
      });
    }

    return { id: updated.id, status: updated.status };
  });
}

export async function failRunAuthorization(
  db: Database,
  input: { runId: string; reason: string; failedAt?: Date },
): Promise<boolean> {
  const failedAt = input.failedAt ?? new Date();
  const [updated] = await db
    .update(runs)
    .set({
      status: "FAILED",
      authorizationReason: input.reason.slice(0, 2_000),
      statusReason: input.reason.slice(0, 2_000),
      failureClassification: "TRANSIENT_INFRASTRUCTURE",
      authorizationCheckedAt: failedAt,
      updatedAt: failedAt,
      version: sql`${runs.version} + 1`,
    })
    .where(and(eq(runs.id, input.runId), eq(runs.status, "AUTHORIZING")))
    .returning({ id: runs.id });

  return updated !== undefined;
}

export async function findRunForBaseline(db: Database, runId: string) {
  const [run] = await db
    .select({
      id: runs.id,
      status: runs.status,
      mode: runs.mode,
      githubInstallationId: runs.githubInstallationId,
      githubRepositoryId: runs.githubRepositoryId,
      repositoryFullName: runs.repositoryFullName,
      defaultBranch: runs.defaultBranch,
      targetCommitSha: runs.targetCommitSha,
      detectedPackageManager: runs.detectedPackageManager,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  return run ?? null;
}

export async function beginRunProvisioning(
  db: Database,
  input: {
    runId: string;
    commitSha: string;
    packageManager: "npm" | "pnpm" | "yarn";
    startedAt?: Date;
  },
): Promise<boolean> {
  const startedAt = input.startedAt ?? new Date();
  const [updated] = await db
    .update(runs)
    .set({
      status: "PROVISIONING",
      targetCommitSha: input.commitSha,
      detectedPackageManager: input.packageManager,
      statusReason: "Repository snapshot captured; provisioning sandbox",
      updatedAt: startedAt,
      version: sql`${runs.version} + 1`,
    })
    .where(and(eq(runs.id, input.runId), eq(runs.status, "PREPARING")))
    .returning({ id: runs.id });

  return updated !== undefined;
}

export async function beginRunBaselining(
  db: Database,
  runId: string,
  startedAt = new Date(),
): Promise<boolean> {
  const [updated] = await db
    .update(runs)
    .set({
      status: "BASELINING",
      statusReason: "Running the unchanged repository test suite",
      updatedAt: startedAt,
      version: sql`${runs.version} + 1`,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "PROVISIONING")))
    .returning({ id: runs.id });

  return updated !== undefined;
}

function baselineOutcome(
  mode: RunMode,
  result: RecordedBaselineResult,
): { status: RunStatus; reason: string; failureClassification: RunFailureClassification | null } {
  if (result.install.timedOut) {
    return { status: "FAILED", reason: "Locked dependency installation timed out", failureClassification: "TRANSIENT_INFRASTRUCTURE" };
  }

  if (result.install.exitCode !== 0) {
    return {
      status: "FAILED",
      reason: `Locked dependency installation failed with exit code ${String(result.install.exitCode)}`,
      failureClassification: "PERMANENT_CONFIGURATION",
    };
  }

  if (!result.test) {
    return { status: "FAILED", reason: "Baseline test did not start", failureClassification: "TRANSIENT_INFRASTRUCTURE" };
  }

  if (result.test.timedOut) {
    return { status: "FAILED", reason: "Baseline test timed out", failureClassification: "TRANSIENT_INFRASTRUCTURE" };
  }

  if (result.test.exitCode === 0) {
    return mode === "TEST"
      ? { status: "SUCCEEDED", reason: "Baseline test suite passed", failureClassification: null }
      : {
          status: "DIAGNOSING",
          reason: "Baseline test suite passed; a controlled regression reproducer is required before source repair",
          failureClassification: "UNREPRODUCED_BUG",
        };
  }

  return mode === "TEST"
    ? {
        status: "FAILED",
        reason: `Baseline test suite failed with exit code ${String(result.test.exitCode)}`,
        failureClassification: "BASELINE_TEST_FAILURE",
      }
    : {
        status: "DIAGNOSING",
        reason: `Baseline failure reproduced with exit code ${String(result.test.exitCode)}`,
        failureClassification: null,
      };
}

export async function completeRunBaseline(
  db: Database,
  input: {
    runId: string;
    mode: RunMode;
    result: RecordedBaselineResult;
    completedAt?: Date;
  },
): Promise<{ status: RunStatus; reason: string } | null> {
  const completedAt = input.completedAt ?? new Date();
  const outcome = baselineOutcome(input.mode, input.result);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(runs)
      .set({
        status: outcome.status,
        statusReason: outcome.reason,
        failureClassification: outcome.failureClassification,
        baselineCompletedAt: completedAt,
        updatedAt: completedAt,
        version: sql`${runs.version} + 1`,
      })
      .where(and(eq(runs.id, input.runId), eq(runs.status, "BASELINING")))
      .returning({ id: runs.id });

    if (!updated) {
      return null;
    }

    const executions = [
      { phase: "DEPENDENCY_INSTALL" as const, execution: input.result.install },
      ...(input.result.test
        ? [{ phase: "BASELINE_TEST" as const, execution: input.result.test }]
        : []),
    ];

    await tx.insert(sandboxExecutions).values(
      executions.map(({ phase, execution }) => ({
        runId: input.runId,
        phase,
        image: input.result.image,
        command: [...execution.command],
        exitCode: execution.exitCode,
        timedOut: execution.timedOut,
        durationMs: execution.durationMs,
        stdout: execution.stdout,
        stderr: execution.stderr,
        outputTruncated: execution.outputTruncated,
        createdAt: completedAt,
      })),
    );

    await tx.insert(outboxEvents).values({
      aggregateType: "run", aggregateId: input.runId,
      eventType: "run.followup.requested",
      payload: { runId: input.runId, mode: input.mode },
    });

    return outcome;
  });
}

export async function failRunBaseline(
  db: Database,
  input: { runId: string; reason: string; failedAt?: Date },
): Promise<boolean> {
  const failedAt = input.failedAt ?? new Date();
  const [updated] = await db
    .update(runs)
    .set({
      status: "FAILED",
      statusReason: input.reason.slice(0, 2_000),
      failureClassification: "TRANSIENT_INFRASTRUCTURE",
      updatedAt: failedAt,
      version: sql`${runs.version} + 1`,
    })
    .where(
      and(
        eq(runs.id, input.runId),
        inArray(runs.status, ["PREPARING", "PROVISIONING", "BASELINING"]),
      ),
    )
    .returning({ id: runs.id });

  return updated !== undefined;
}
