import { agentContractVersion, type GitHubRunContinuation, type GitHubRunTrigger } from "@devsentinel/domain";
import { and, desc, eq } from "drizzle-orm";

import type { Database } from "./client.js";
import { outboxEvents, runClarifications, runEvents, runs, runTaskBriefs, webhookDeliveries } from "./schema.js";

export interface IngestWebhookInput {
  deliveryId: string;
  eventName: string;
  action: string | null;
  payload: unknown;
  trigger: GitHubRunTrigger | null;
}

export type IngestWebhookResult =
  | { kind: "accepted"; runId: string }
  | { kind: "duplicate" }
  | { kind: "ignored" };

function markdownCriteria(body: string): string[] {
  return body.split(/\r?\n/)
    .map((line) => /^\s*[-*]\s+\[[ xX]\]\s+(.+)$/.exec(line)?.[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .slice(0, 20)
    .map((value) => value.slice(0, 1_000));
}

function taskBrief(input: IngestWebhookInput, deliveryId: string) {
  const trigger = input.trigger!;
  const issueTitle = trigger.issueTitle?.trim() ?? "";
  const issueBody = trigger.issueBody?.trim() ?? "";
  const command = trigger.commandContext;
  const requestedOutcome = command?.requestedOutcome || issueTitle ||
    (trigger.mode === "FIX"
      ? `Resolve the reported behavior in issue #${trigger.issueNumber}`
      : `Run the repository test suite for issue #${trigger.issueNumber}`);
  const acceptanceCriteria = command?.acceptanceCriteria.length
    ? command.acceptanceCriteria
    : markdownCriteria(issueBody);
  return {
    contractVersion: agentContractVersion,
    issueTitle: issueTitle.slice(0, 2_000),
    issueBody: issueBody.slice(0, 100_000),
    triggerComment: trigger.triggerComment?.slice(0, 100_000) ?? null,
    commandContext: command?.raw.slice(0, 16_000) ?? "",
    requestedOutcome: requestedOutcome.slice(0, 4_000),
    acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : [
      trigger.mode === "FIX"
        ? "The reported issue is reproduced and resolved without changing unrelated behavior"
        : "The unchanged repository test result is recorded with bounded evidence",
    ],
    constraints: [
      "Issue-scoped work only; unrelated failures and improvements are excluded",
      ...(command?.constraints ?? []),
    ].slice(0, 20),
    approvedPaths: command?.approvedPaths ?? [],
    excludedPaths: command?.excludedPaths ?? [],
    authorizedActor: trigger.actorLogin,
    source: {
      eventName: input.eventName,
      activation: trigger.activation,
      deliveryId,
      issueId: trigger.issueId ?? null,
      issueCreatedAt: trigger.issueCreatedAt ?? null,
      issueUpdatedAt: trigger.issueUpdatedAt ?? null,
      commentId: trigger.triggerCommentId ?? null,
      commentCreatedAt: trigger.triggerCommentCreatedAt ?? null,
    },
  };
}

export async function ingestWebhook(
  db: Database,
  input: IngestWebhookInput,
): Promise<IngestWebhookResult> {
  return db.transaction(async (tx) => {
    const [delivery] = await tx
      .insert(webhookDeliveries)
      .values({
        deliveryId: input.deliveryId,
        eventName: input.eventName,
        action: input.action,
        payload: input.payload,
      })
      .onConflictDoNothing({ target: webhookDeliveries.deliveryId })
      .returning({ id: webhookDeliveries.id });

    if (!delivery) {
      return { kind: "duplicate" };
    }

    if (!input.trigger) {
      await tx
        .update(webhookDeliveries)
        .set({ disposition: "IGNORED", processedAt: new Date() })
        .where(eq(webhookDeliveries.id, delivery.id));

      return { kind: "ignored" };
    }

    const [run] = await tx
      .insert(runs)
      .values({
        triggerDeliveryId: delivery.id,
        githubInstallationId: input.trigger.installationId,
        githubRepositoryId: input.trigger.repositoryId,
        repositoryFullName: input.trigger.repositoryFullName,
        defaultBranch: input.trigger.defaultBranch,
        issueNumber: input.trigger.issueNumber,
        actorLogin: input.trigger.actorLogin,
        activation: input.trigger.activation,
        mode: input.trigger.mode,
        status: "AUTHORIZING",
      })
      .returning({ id: runs.id });

    if (!run) {
      throw new Error("Run insertion did not return a row");
    }

    await tx.insert(runTaskBriefs).values({
      runId: run.id,
      ...taskBrief(input, input.deliveryId),
    });

    await tx.insert(outboxEvents).values({
      aggregateType: "run",
      aggregateId: run.id,
      eventType: "run.authorization.requested",
      payload: { runId: run.id, mode: input.trigger.mode },
    });

    await tx
      .update(webhookDeliveries)
      .set({ disposition: "ACCEPTED", processedAt: new Date() })
      .where(eq(webhookDeliveries.id, delivery.id));

    return { kind: "accepted", runId: run.id };
  });
}

export type IngestContinuationResult =
  | { kind: "accepted"; runId: string }
  | { kind: "duplicate" }
  | { kind: "ignored"; reason: string };

export async function ingestRunContinuation(
  db: Database,
  input: Omit<IngestWebhookInput, "trigger"> & { continuation: GitHubRunContinuation },
): Promise<IngestContinuationResult> {
  return db.transaction(async (tx) => {
    const [delivery] = await tx.insert(webhookDeliveries).values({
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      action: input.action,
      payload: input.payload,
    }).onConflictDoNothing({ target: webhookDeliveries.deliveryId })
      .returning({ id: webhookDeliveries.id });
    if (!delivery) return { kind: "duplicate" };

    const [run] = await tx.select().from(runs)
      .where(eq(runs.id, input.continuation.runId)).for("update");
    const [brief] = run ? await tx.select().from(runTaskBriefs)
      .where(eq(runTaskBriefs.runId, run.id)) : [];
    const [clarification] = run ? await tx.select().from(runClarifications)
      .where(and(eq(runClarifications.runId, run.id), eq(runClarifications.status, "OPEN")))
      .orderBy(desc(runClarifications.requestedAt)).limit(1).for("update") : [];

    const matches = run && brief && clarification &&
      run.status === "AWAITING_CLARIFICATION" &&
      run.githubRepositoryId === input.continuation.repositoryId &&
      run.repositoryFullName === input.continuation.repositoryFullName &&
      run.issueNumber === input.continuation.issueNumber &&
      brief.authorizedActor.toLowerCase() === input.continuation.actorLogin.toLowerCase();
    if (!matches) {
      await tx.update(webhookDeliveries).set({ disposition: "IGNORED", processedAt: new Date() })
        .where(eq(webhookDeliveries.id, delivery.id));
      return { kind: "ignored", reason: "Continuation did not match an open authorized clarification" };
    }

    const now = new Date();
    if (clarification.deadlineAt <= now) {
      await tx.update(runClarifications).set({ status: "EXPIRED" })
        .where(eq(runClarifications.id, clarification.id));
      await tx.update(runs).set({
        status: "NEEDS_HUMAN",
        statusReason: "Clarification deadline expired; start a new run with the answer included",
        failureClassification: "UNCLEAR_TASK",
        updatedAt: now,
      }).where(eq(runs.id, run.id));
      await tx.update(webhookDeliveries).set({ disposition: "IGNORED", processedAt: now })
        .where(eq(webhookDeliveries.id, delivery.id));
      return { kind: "ignored", reason: "Clarification deadline expired" };
    }

    await tx.update(runClarifications).set({
      status: "ANSWERED",
      answer: input.continuation.answer,
      answeredBy: input.continuation.actorLogin,
      answerDeliveryId: input.deliveryId,
      answerCommentId: input.continuation.deliveryCommentId,
      answeredAt: now,
    }).where(eq(runClarifications.id, clarification.id));
    await tx.update(runs).set({
      status: "DIAGNOSING",
      statusReason: "Authorized clarification received; investigation will resume from its saved checkpoint",
      failureClassification: null,
      updatedAt: now,
    }).where(eq(runs.id, run.id));
    await tx.insert(runEvents).values({
      runId: run.id,
      kind: "clarification.answered",
      message: `Clarification answered by ${input.continuation.actorLogin}; provenance ${input.deliveryId}`,
    });
    await tx.insert(outboxEvents).values({
      aggregateType: "run",
      aggregateId: run.id,
      eventType: "run.followup.requested",
      payload: { runId: run.id, mode: run.mode },
    });
    await tx.update(webhookDeliveries).set({ disposition: "ACCEPTED", processedAt: now })
      .where(eq(webhookDeliveries.id, delivery.id));
    return { kind: "accepted", runId: run.id };
  });
}
