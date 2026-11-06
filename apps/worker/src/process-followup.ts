import { randomUUID } from "node:crypto";
import {
  assertWorkflow,
  checkpoint,
  claimWorkflow,
  getAgentTaskContext,
  getRunDetail,
  recordContextProvenance,
  releaseWorkflow,
  renewWorkflow,
  requestClarificationCheckpoint,
  reserveAttempt,
  saveRunPlan,
  type Database,
  type RecordedBaselineResult,
} from "@devsentinel/database";
import { isTerminalRunStatus } from "@devsentinel/domain";
import type { BaselineJobData } from "@devsentinel/queue";
import { detectNodeProject, type BaselineSandbox } from "@devsentinel/sandbox";

import { AgentToolSession } from "./agent-tools.js";
import type { RunAuthorizer } from "./authorization.js";
import type { ResultPublisher } from "./github-delivery.js";
import type { IssueContextProvider } from "./issue-context.js";
import { ModelCallError, modelInput, repairInstructions, type RepairModel, type RepairResponse } from "./repair-model.js";
import { applyProposal, redact, repositoryFingerprint, validateProposal, type RepairProposal } from "./repair-policy.js";
import { loadRepositoryGuidance } from "./repository-guidance.js";
import { applyFrozenRegressionTest, validateRegressionTestProposal } from "./regression-policy.js";
import type { RepositorySource } from "./repository-source.js";
import { assessVerification, chooseTestProfile, executionPassed, planForTestProfile } from "./verification-policy.js";

export interface FollowupPolicy {
  maxAttempts: number;
  maxTokens: number;
  maxOutputTokens: number;
  maxDurationMs: number;
  modelTimeoutMs: number;
  maxContextBytes: number;
  maxModelTurns: number;
  maxToolCalls: number;
  maxToolOutputBytes: number;
  clarificationTtlMs: number;
  allowRegressionTests: boolean;
  inputCostMicrousdPerMillion: number | null;
  outputCostMicrousdPerMillion: number | null;
  allowedRepositories: string[];
}

export const defaultFollowupPolicy: FollowupPolicy = {
  maxAttempts: 3,
  maxTokens: 200000,
  maxOutputTokens: 4096,
  maxDurationMs: 900000,
  modelTimeoutMs: 120000,
  maxContextBytes: 48000,
  maxModelTurns: 4,
  maxToolCalls: 24,
  maxToolOutputBytes: 16 * 1024,
  clarificationTtlMs: 172800000,
  allowRegressionTests: false,
  inputCostMicrousdPerMillion: null,
  outputCostMicrousdPerMillion: null,
  allowedRepositories: [],
};

type Detail = NonNullable<Awaited<ReturnType<typeof getRunDetail>>>;

function baselineEvidence(detail: Detail): RecordedBaselineResult | null {
  const install = detail.executions.find((item) => item.phase === "DEPENDENCY_INSTALL");
  const test = detail.executions.find((item) => item.phase === "BASELINE_TEST");
  if (!install) return null;
  const command = (row: typeof install) => ({
    command: row.command,
    exitCode: row.exitCode,
    timedOut: row.timedOut,
    durationMs: row.durationMs,
    stdout: row.stdout,
    stderr: row.stderr,
    outputTruncated: row.outputTruncated,
  });
  return { image: install.image, install: command(install), test: test ? command(test) : null };
}

function samePatch(left: RepairProposal | null | undefined, right: RepairProposal): boolean {
  return Boolean(left) && JSON.stringify(left!.edits) === JSON.stringify(right.edits);
}

function estimatedCost(policy: FollowupPolicy, inputTokens: number | null, outputTokens: number | null): number | null {
  if (inputTokens === null || outputTokens === null || policy.inputCostMicrousdPerMillion === null || policy.outputCostMicrousdPerMillion === null) return null;
  const numerator = BigInt(inputTokens) * BigInt(policy.inputCostMicrousdPerMillion) +
    BigInt(outputTokens) * BigInt(policy.outputCostMicrousdPerMillion);
  const value = (numerator + 999_999n) / 1_000_000n;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function activeRepairElapsedMs(detail: Detail): number {
  if (!detail.workflow) return 0;
  const pausedMs = detail.clarifications.reduce((total, clarification) => {
    if (!clarification.answeredAt) return total;
    const boundedAnswer = Math.min(clarification.answeredAt.getTime(), clarification.deadlineAt.getTime());
    return total + Math.max(0, boundedAnswer - clarification.requestedAt.getTime());
  }, 0);
  return Math.max(0, Date.now() - detail.workflow.startedAt.getTime() - pausedMs);
}

function safeTaskBrief(detail: Detail) {
  const brief = detail.taskBrief;
  if (!brief) return null;
  return {
    mode: detail.run.mode,
    requestedOutcome: brief.requestedOutcome,
    acceptanceCriteria: brief.acceptanceCriteria,
    constraints: brief.constraints,
    approvedPaths: brief.approvedPaths,
    excludedPaths: brief.excludedPaths,
    authorizedActor: brief.authorizedActor,
    capturedCommit: brief.capturedCommitSha,
    source: brief.source,
  };
}

export async function processFollowupJob(options: {
  db: Database;
  repositorySource: RepositorySource;
  sandbox: BaselineSandbox;
  model: RepairModel | null;
  publisher: ResultPublisher;
  policy: FollowupPolicy;
  authorizer?: RunAuthorizer;
  issueContext?: IssueContextProvider;
}, data: BaselineJobData) {
  const { db, policy } = options;
  let detail = await getRunDetail(db, data.runId);
  if (!detail || detail.run.mode !== data.mode) throw new Error("Unknown run or run mode mismatch");
  if (detail.run.status === "CANCELLED" || detail.workflow?.deliveryCompletedAt) return { outcome: "already-processed" };

  const owner = randomUUID();
  if (!await claimWorkflow(db, data.runId, owner)) throw new Error("Another worker owns this run; retry later");
  const abort = new AbortController();
  let heartbeatPending = false;
  const heartbeat = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    void (async () => {
      try {
        await assertWorkflow(db, data.runId, owner);
        if (!await renewWorkflow(db, data.runId, owner)) abort.abort();
      } catch { abort.abort(); }
      finally { heartbeatPending = false; }
    })();
  }, 10000);
  const guard = async () => {
    if (abort.signal.aborted) throw new Error("Workflow cancelled or lease lost");
    await assertWorkflow(db, data.runId, owner);
  };
  const record = (input: Parameters<typeof checkpoint>[3]) => checkpoint(db, data.runId, owner, input);
  const progress = async (phase: string, message: string) => {
    if (!options.publisher.progress) return;
    const current = await getRunDetail(db, data.runId);
    if (!current) return;
    try {
      await options.publisher.progress({
        detail: current,
        proposal: null,
        guard,
        save: (delivery) => record({ kind: "delivery.checkpoint", reason: "Saved reconciled progress comment", delivery }),
      }, { phase, message });
    } catch {
      await record({ kind: "delivery.progress-warning", reason: "A GitHub progress comment update failed; local execution evidence remains authoritative" });
    }
  };

  try {
    detail = (await getRunDetail(db, data.runId))!;
    if (!policy.allowedRepositories.includes(detail.run.repositoryFullName)) {
      if (!isTerminalRunStatus(detail.run.status)) await record({
        status: "NEEDS_HUMAN",
        failureClassification: "POLICY_BLOCKED",
        kind: "policy.denied",
        reason: "Repository is not in AGENT_ALLOWED_REPOSITORIES",
      });
      return { outcome: "repository-not-enabled" };
    }
    if (detail.run.status === "AWAITING_CLARIFICATION") return { outcome: "awaiting-clarification" };
    if (!["DIAGNOSING", "PATCHING", "VERIFYING", "PUBLISHING"].includes(detail.run.status) && !isTerminalRunStatus(detail.run.status)) return { outcome: "not-ready" };

    if (options.authorizer && ["DIAGNOSING", "PATCHING", "VERIFYING"].includes(detail.run.status)) {
      const decision = await options.authorizer.authorize({ ...detail.run, runId: data.runId });
      if (!decision.allowed) {
        await record({ status: "NEEDS_HUMAN", failureClassification: "POLICY_BLOCKED", kind: "execution.permission-denied", reason: "Actor no longer meets repository permission policy; costly repair execution is blocked" });
        return { outcome: "permission-denied" };
      }
    }

    if (detail.run.mode === "FIX" && ["DIAGNOSING", "PATCHING", "VERIFYING"].includes(detail.run.status)) {
      const discussion = options.issueContext ? await options.issueContext.collect({
        installationId: detail.run.githubInstallationId,
        repositoryId: detail.run.githubRepositoryId,
        repositoryFullName: detail.run.repositoryFullName,
        issueNumber: detail.run.issueNumber,
      }) : [];
      if (!options.model) {
        await record({ status: "NEEDS_HUMAN", failureClassification: "PERMANENT_CONFIGURATION", kind: "model.disabled", reason: "Configure AGENT_MODEL_PROVIDER, OPENAI_API_KEY, and OPENAI_MODEL to enable repair" });
      } else {
        while (true) {
          await guard();
          detail = (await getRunDetail(db, data.runId))!;
          if (isTerminalRunStatus(detail.run.status) || detail.run.status === "PUBLISHING" || detail.run.status === "AWAITING_CLARIFICATION") break;
          const elapsed = activeRepairElapsedMs(detail);
          if (elapsed >= policy.maxDurationMs) {
            await record({ status: "BUDGET_EXHAUSTED", failureClassification: "BUDGET_EXHAUSTED", kind: "budget.time", reason: "Repair active-time budget exhausted" });
            break;
          }
          if (!detail.run.targetCommitSha) throw new Error("Repair requires a captured baseline commit");

          const snapshot = await options.repositorySource.materialize({
            githubInstallationId: detail.run.githubInstallationId,
            githubRepositoryId: detail.run.githubRepositoryId,
            repositoryFullName: detail.run.repositoryFullName,
            ref: detail.run.targetCommitSha,
          });
          try {
            if (snapshot.commitSha !== detail.run.targetCommitSha) throw new Error("Repair snapshot does not match baseline commit");
            const projectPlan = await detectNodeProject(snapshot.path);
            const guidance = await loadRepositoryGuidance(snapshot.path);
            if (detail.taskBrief?.guidanceHash && (detail.taskBrief.guidanceHash !== guidance.hash || detail.taskBrief.guidanceVersion !== guidance.version)) {
              await record({ status: "NEEDS_HUMAN", failureClassification: "POLICY_BLOCKED", kind: "guidance.mismatch", reason: "Repository guidance does not match the version pinned to the captured task brief" });
              break;
            }

            const expandedPaths = detail.approvals.filter((approval) => approval.kind === "SCOPE_EXPANSION").flatMap((approval) => approval.paths);
            const approvedPaths = [...(detail.taskBrief?.approvedPaths ?? []), ...expandedPaths];
            let attempt = detail.attempts.at(-1);
            if (attempt?.status === "RESERVED") {
              await record({
                kind: "model.interrupted",
                reason: "Previous model call was interrupted; its reservation remains charged",
                attemptId: attempt.id,
                attempt: { status: "INTERRUPTED" },
              });
              attempt = { ...attempt, status: "INTERRUPTED" };
            }
            const resumesSavedProposal = Boolean(attempt && ["PROPOSED", "VERIFYING"].includes(attempt.status));
            const remainingAttempts = Math.max(1, policy.maxAttempts - detail.workflow!.attemptCount);
            const remainingToolCalls = Math.max(0, policy.maxToolCalls - detail.workflow!.toolCallCount);
            const remainingToolOutputBytes = Math.max(0, policy.maxToolOutputBytes - detail.workflow!.toolOutputBytes);
            if (!resumesSavedProposal && (remainingToolCalls === 0 || remainingToolOutputBytes === 0)) {
              await record({
                status: "BUDGET_EXHAUSTED",
                failureClassification: "BUDGET_EXHAUSTED",
                kind: "budget.tools",
                reason: "Durable agent tool call or output budget exhausted before another model attempt",
              });
              break;
            }
            const attemptToolCalls = Math.min(remainingToolCalls, Math.ceil(remainingToolCalls / remainingAttempts));
            const attemptToolOutputBytes = Math.min(remainingToolOutputBytes, Math.ceil(remainingToolOutputBytes / remainingAttempts));
            const toolSession = new AgentToolSession({
              root: snapshot.path,
              config: guidance.config,
              approvedPaths,
              excludedPaths: detail.taskBrief?.excludedPaths ?? [],
              allowRegressionTests: policy.allowRegressionTests,
              budget: {
                // Source-catalog validation itself does not consume model tool
                // calls. A saved proposal may therefore resume after spending
                // its entire reserved tool allowance, without granting a new
                // model call.
                maxCalls: Math.max(1, attemptToolCalls),
                maxOutputBytes: Math.max(1, attemptToolOutputBytes),
                deadlineMs: Date.now() + Math.max(1, policy.maxDurationMs - activeRepairElapsedMs(detail)),
              },
            });

            const originalBaseline = baselineEvidence(detail);
            const baselineWasGreen = executionPassed(originalBaseline);
            if (baselineWasGreen && (!policy.allowRegressionTests || !guidance.config.regressionTests.enabled)) {
              await record({ status: "NEEDS_HUMAN", failureClassification: "UNREPRODUCED_BUG", kind: "regression.disabled", reason: "The existing suite is green. A regression reproducer is required, but the audited capability is not enabled by both platform and captured repository policy" });
              break;
            }

            if (!attempt || !["PROPOSED", "VERIFYING"].includes(attempt.status)) {
              const previous = detail.attempts.filter((item) => item.proposal).at(-1);
              const failure = previous?.verification?.test ?? detail.executions.find((item) => item.phase === "BASELINE_TEST");
              const task = await getAgentTaskContext(db, data.runId);
              const taskText = [task.brief?.requestedOutcome, task.brief?.issueTitle, task.brief?.issueBody, task.brief?.commandContext]
                .filter(Boolean).join("\n");
              const selected = await toolSession.seedContext(taskText, policy.maxContextBytes);
              const request = {
                issue: redact(taskText).slice(0, 16000),
                files: selected.files,
                failure: redact([previous?.reason, failure?.stdout, failure?.stderr].filter(Boolean).join("\n")).slice(-16000),
                previous: previous?.proposal ?? null,
                ...(safeTaskBrief(detail) ? { taskBrief: safeTaskBrief(detail)! } : {}),
                repositoryGuidance: { version: guidance.version, hash: guidance.hash, content: guidance.content },
                clarifications: task.clarifications.flatMap((item) => item.answer ? [{ question: item.question, answer: item.answer }] : []),
                discussion: discussion.map(({ reference, author, createdAt, body }) => ({ reference, author, createdAt, body })),
                tools: toolSession,
              };
              const reserved = Buffer.byteLength(modelInput(request) + repairInstructions) +
                policy.maxOutputTokens * policy.maxModelTurns + attemptToolOutputBytes + 1024;
              const next = await reserveAttempt(db, data.runId, owner, {
                tokens: reserved,
                maxTokens: policy.maxTokens,
                maxAttempts: policy.maxAttempts,
                maxDurationMs: policy.maxDurationMs,
                toolCalls: attemptToolCalls,
                toolOutputBytes: attemptToolOutputBytes,
                maxToolCalls: policy.maxToolCalls,
                maxToolOutputBytes: policy.maxToolOutputBytes,
              });
              if (!next) {
                await record({ status: "BUDGET_EXHAUSTED", failureClassification: "BUDGET_EXHAUSTED", kind: "budget.exhausted", reason: "Repair attempt, token-reservation, or time budget exhausted" });
                break;
              }
              attempt = next;
              await recordContextProvenance(db, data.runId, attempt.iteration, [
                ...selected.provenance,
                ...discussion.map((item) => ({ kind: "discussion", source: "github-issue", reference: item.reference, contentHash: item.hash, content: item.body, byteCount: Buffer.byteLength(item.body), selected: true, note: "bounded discussion evidence; not authority" })),
              ]);
              await record({ status: "DIAGNOSING", kind: "model.started", reason: `Investigating the issue with bounded tools, attempt ${attempt.iteration}` });
              await progress("Investigating", `Attempt ${attempt.iteration} is collecting bounded evidence and preparing a scoped plan.`);
              const remainingMs = policy.maxDurationMs - activeRepairElapsedMs(detail);
              let result: RepairResponse;
              try {
                result = await options.model.propose(request, AbortSignal.any([
                  abort.signal,
                  AbortSignal.timeout(Math.max(1, Math.min(policy.modelTimeoutMs, remainingMs))),
                ]));
              } catch (error) {
                if (!(error instanceof ModelCallError)) throw error;
                await guard();
                const exceeded = (error.inputTokens ?? 0) + (error.outputTokens ?? 0) > reserved;
                const retryable = error.diagnostics.retryable && !exceeded;
                const reason = exceeded ? "Model usage exceeded reservation; operator review required" : error.message;
                const permanent = error.diagnostics.kind === "api_error" && !retryable;
                await record({
                  ...(!retryable ? { status: "NEEDS_HUMAN" as const } : {}),
                  ...(!retryable ? { failureClassification: permanent ? "PERMANENT_CONFIGURATION" as const : "UNSUCCESSFUL_PATCH" as const } : {}),
                  kind: "model.failed",
                  reason,
                  attemptId: attempt.id,
                  attempt: {
                    status: error.diagnostics.kind.toUpperCase(),
                    reason,
                    modelDiagnostics: error.diagnostics,
                    inputTokens: error.inputTokens,
                    outputTokens: error.outputTokens,
                    estimatedCostMicrousd: estimatedCost(policy, error.inputTokens, error.outputTokens),
                    toolCalls: toolSession.calls,
                    toolOutputBytes: toolSession.outputBytes,
                    toolTrace: toolSession.trace,
                  },
                });
                if (retryable) throw error;
                break;
              }
              await guard();
              const modelEvidence = {
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                estimatedCostMicrousd: estimatedCost(policy, result.inputTokens, result.outputTokens),
                modelDiagnostics: result.diagnostics ?? null,
                toolCalls: result.toolTrace?.length ?? toolSession.calls,
                toolOutputBytes: result.toolTrace?.reduce((sum, item) => sum + item.outputBytes, 0) ?? toolSession.outputBytes,
                toolTrace: result.toolTrace ?? toolSession.trace,
              };
              if (result.inputTokens + result.outputTokens > reserved) {
                await record({ status: "NEEDS_HUMAN", failureClassification: "BUDGET_EXHAUSTED", kind: "model.usage-exceeded", reason: "Model usage exceeded reservation; operator review required", attemptId: attempt.id, attempt: { ...modelEvidence, status: "USAGE_EXCEEDED" } });
                break;
              }
              if (result.clarification) {
                if (result.plan) await saveRunPlan(db, data.runId, result.plan);
                await record({ kind: "model.clarification", reason: result.proposal.summary, attemptId: attempt.id, attempt: { status: "CLARIFICATION", proposal: result.proposal, reason: result.proposal.summary, ...modelEvidence } });
                await requestClarificationCheckpoint(db, data.runId, owner, result.clarification, new Date(Date.now() + policy.clarificationTtlMs));
                break;
              }
              if (result.proposal.edits.length === 0) {
                const reason = redact(result.proposal.summary).slice(0, 2000);
                if (result.plan) await saveRunPlan(db, data.runId, result.plan);
                await record({ status: "NEEDS_HUMAN", failureClassification: "UNSUCCESSFUL_PATCH", kind: "model.escalated", reason, attemptId: attempt.id, attempt: { status: "ESCALATED", proposal: result.proposal, reason, ...modelEvidence } });
                break;
              }

              if (baselineWasGreen && !result.regressionTest) {
                const reason = "The unchanged suite is green, but the agent did not provide a separately audited regression reproducer";
                await record({ status: "NEEDS_HUMAN", failureClassification: "UNREPRODUCED_BUG", kind: "regression.missing", reason, attemptId: attempt.id, attempt: { status: "ESCALATED", proposal: result.proposal, reason, ...modelEvidence } });
                break;
              }

              let regressionTest = result.regressionTest ?? null;
              if (regressionTest) {
                try {
                  const validated = validateRegressionTestProposal({ summary: regressionTest.summary, path: regressionTest.path, content: regressionTest.content }, guidance.config.regressionTests.allowedPaths);
                  if (regressionTest.hash && regressionTest.hash !== validated.hash) throw new Error("Regression hash mismatch");
                  regressionTest = validated;
                } catch {
                  const reason = "Application policy rejected the proposed regression reproducer";
                  await record({ status: "NEEDS_HUMAN", failureClassification: "POLICY_BLOCKED", kind: "regression.rejected", reason, attemptId: attempt.id, attempt: { status: "REJECTED", reason, ...modelEvidence } });
                  break;
                }
              }

              const catalog = await toolSession.sourceCatalog();
              let proposal: RepairProposal;
              try { proposal = validateProposal(result.proposal, catalog); }
              catch {
                const reason = `Patch policy rejected the proposed changes. Model explanation: ${redact(result.proposal.summary).slice(0, 1200)}`;
                await record({ status: "NEEDS_HUMAN", failureClassification: "POLICY_BLOCKED", kind: "patch.rejected", reason, attemptId: attempt.id, attempt: { status: "REJECTED", proposal: result.proposal, reason, ...modelEvidence } });
                break;
              }
              if (samePatch(previous?.proposal, proposal)) {
                const reason = `The agent repeated an identical patch after the same failure; stopped early. ${redact(proposal.summary)}`;
                await record({ status: "NEEDS_HUMAN", failureClassification: "UNSUCCESSFUL_PATCH", kind: "patch.repeated", reason, attemptId: attempt.id, attempt: { status: "REPEATED", proposal, reason, ...modelEvidence } });
                break;
              }
              if (result.plan) await saveRunPlan(db, data.runId, result.plan);
              await record({
                status: "PATCHING",
                kind: "patch.saved",
                reason: `Saved ${proposal.edits.length} scoped source edit(s) for attempt ${attempt.iteration}`,
                attemptId: attempt.id,
                attempt: { status: "PROPOSED", proposal, regressionTest, ...modelEvidence },
              });
              attempt = { ...attempt, proposal, regressionTest, status: "PROPOSED" };
            }

            if (!attempt.proposal || attempt.proposal.edits.length === 0) throw new Error("Persisted source proposal is missing");
            const catalog = await toolSession.sourceCatalog();
            const proposal = validateProposal(attempt.proposal, catalog);
            let regressionBaseline: RecordedBaselineResult | null = null;
            if (baselineWasGreen) {
              if (!attempt.regressionTest) throw new Error("Persisted audited regression reproducer is missing");
              await applyFrozenRegressionTest(snapshot.path, attempt.regressionTest);
              const frozen = await repositoryFingerprint(snapshot.path);
              regressionBaseline = await options.sandbox.executeBaseline({
                runId: `${data.runId}-a${attempt.iteration}-reproducer-original`,
                workspacePath: snapshot.path,
                plan: planForTestProfile(projectPlan, [attempt.regressionTest.path]),
                signal: abort.signal,
                deadlineMs: Date.now() + Math.max(1, policy.maxDurationMs - activeRepairElapsedMs(detail)),
              });
              await guard();
              if (await repositoryFingerprint(snapshot.path) !== frozen) {
                await record({ status: "NEEDS_HUMAN", failureClassification: "POLICY_BLOCKED", kind: "regression.tampered", reason: "Regression execution modified the frozen reproducer or repository files", attemptId: attempt.id, attempt: { status: "REJECTED", regressionBaseline } });
                break;
              }
              const reproduced = regressionBaseline.install.exitCode === 0 && !regressionBaseline.install.timedOut && Boolean(regressionBaseline.test && regressionBaseline.test.exitCode !== 0 && !regressionBaseline.test.timedOut);
              if (!reproduced) {
                const reason = "The frozen regression test did not fail on the untouched source revision; source repair is blocked";
                await record({ status: "NEEDS_HUMAN", failureClassification: "UNREPRODUCED_BUG", kind: "regression.not-reproduced", reason, attemptId: attempt.id, attempt: { status: "ESCALATED", regressionBaseline, reason } });
                break;
              }
              await record({ kind: "regression.frozen", reason: `Frozen ${attempt.regressionTest.path} (${attempt.regressionTest.hash}) and demonstrated failure on the untouched source`, attemptId: attempt.id, attempt: { regressionBaseline } });
            }
            await applyProposal(snapshot.path, proposal);
            const before = await repositoryFingerprint(snapshot.path);
            await guard();
            if (activeRepairElapsedMs(detail) >= policy.maxDurationMs) {
              await record({ status: "BUDGET_EXHAUSTED", failureClassification: "BUDGET_EXHAUSTED", kind: "budget.time", reason: "Repair time budget exhausted before verification" });
              break;
            }
            await record({ status: "VERIFYING", kind: "verification.started", reason: `Running issue-relevant checks and the required full suite for attempt ${attempt.iteration}`, attemptId: attempt.id, attempt: { status: "VERIFYING" } });
            await progress("Verifying", `Attempt ${attempt.iteration} is running issue-relevant checks and the required full suite in the sandbox.`);

            const taskText = [detail.taskBrief?.requestedOutcome, detail.taskBrief?.issueTitle, detail.taskBrief?.issueBody].filter(Boolean).join("\n");
            const profile = baselineWasGreen ? null : chooseTestProfile(guidance.config, taskText);
            const targetedName = baselineWasGreen ? `regression:${attempt.regressionTest!.path}` : profile?.name ?? null;
            const targetedPaths = baselineWasGreen ? [attempt.regressionTest!.path] : profile?.relevantPaths ?? null;
            const deadlineMs = Date.now() + Math.max(1, policy.maxDurationMs - activeRepairElapsedMs(detail));
            const targeted = targetedPaths ? await options.sandbox.executeBaseline({
              runId: `${data.runId}-a${attempt.iteration}-targeted`,
              workspacePath: snapshot.path,
              plan: planForTestProfile(projectPlan, targetedPaths),
              signal: abort.signal,
              deadlineMs,
            }) : null;
            const result = await options.sandbox.executeBaseline({
              runId: `${data.runId}-a${attempt.iteration}-full`,
              workspacePath: snapshot.path,
              plan: projectPlan,
              signal: abort.signal,
              deadlineMs,
            });
            await guard();
            if (await repositoryFingerprint(snapshot.path) !== before) {
              await record({ status: "NEEDS_HUMAN", failureClassification: "POLICY_BLOCKED", kind: "verification.tampered", reason: "Install or tests modified repository files; refusing to publish", attemptId: attempt.id, attempt: { status: "REJECTED" } });
              break;
            }

            const evidence = JSON.parse(redact(JSON.stringify(result))) as typeof result;
            const targetedEvidence = targeted ? JSON.parse(redact(JSON.stringify(targeted))) as typeof targeted : null;
            const assessment = assessVerification({
              criteria: detail.taskBrief?.acceptanceCriteria ?? ["Recorded issue behavior is resolved"],
              baseline: baselineEvidence(detail),
              targeted: targetedEvidence,
              candidate: evidence,
              profileName: targetedName,
              taskText,
              regressionBaseline,
            });
            const expired = activeRepairElapsedMs(detail) >= policy.maxDurationMs;
            let status: "BUDGET_EXHAUSTED" | "PUBLISHING" | "NEEDS_HUMAN" | "DIAGNOSING";
            let classification: "BUDGET_EXHAUSTED" | "VERIFIED_UNDELIVERED" | "UNSUCCESSFUL_PATCH" | null;
            let reason: string;
            if (expired) {
              status = "BUDGET_EXHAUSTED";
              classification = "BUDGET_EXHAUSTED";
              reason = "Repair time budget exhausted during verification";
            } else if (assessment.deliveryEligible) {
              status = "PUBLISHING";
              classification = null;
              reason = "Acceptance criteria are supported by recorded execution evidence and all required checks passed";
            } else if (assessment.acceptanceCriteriaVerified && assessment.unrelatedBaseline.length > 0) {
              status = "NEEDS_HUMAN";
              classification = "VERIFIED_UNDELIVERED";
              reason = `Issue-relevant checks passed, but ${assessment.unrelatedBaseline.length} unrelated baseline failure(s) block verified delivery`;
            } else if (assessment.targetedPassed && !assessment.fullSuitePassed) {
              status = "NEEDS_HUMAN";
              classification = "VERIFIED_UNDELIVERED";
              reason = "Issue-relevant checks passed, but the required full suite remains red; delivery is blocked";
            } else {
              status = "DIAGNOSING";
              classification = "UNSUCCESSFUL_PATCH";
              reason = assessment.newFailures.length > 0
                ? `Verification introduced ${assessment.newFailures.length} new failure(s); another bounded attempt may be required`
                : "Verification did not support the requested acceptance criteria; another bounded attempt may be required";
            }
            await record({
              status,
              failureClassification: classification,
              kind: status === "PUBLISHING" ? "verification.passed" : status === "NEEDS_HUMAN" ? "verification.blocked" : "verification.failed",
              reason,
              attemptId: attempt.id,
              attempt: {
                status: status === "PUBLISHING" || status === "NEEDS_HUMAN" && assessment.acceptanceCriteriaVerified ? "VERIFIED" : "FAILED",
                verification: evidence,
                targetedVerification: targetedEvidence,
                regressionBaseline,
                regressionCandidate: baselineWasGreen ? targetedEvidence : null,
                acceptanceEvidence: assessment.acceptanceEvidence,
                unrelatedFailures: assessment.unrelatedBaseline,
                requiredChecksPassed: assessment.requiredChecksPassed,
                deliveryEligible: assessment.deliveryEligible,
                reason,
              },
            });
            if (status !== "DIAGNOSING") break;
          } finally {
            await snapshot.cleanup();
          }
        }
      }
    }

    await guard();
    detail = (await getRunDetail(db, data.runId))!;
    if (detail.run.status === "AWAITING_CLARIFICATION") return { outcome: "awaiting-clarification" };
    const verified = detail.attempts.filter((attempt) => attempt.status === "VERIFIED" && attempt.deliveryEligible).at(-1);
    const proposal = detail.run.status === "PUBLISHING" && verified?.proposal ? {
      ...verified.proposal,
      edits: [
        ...verified.proposal.edits,
        ...(verified.regressionTest ? [{ path: verified.regressionTest.path, content: verified.regressionTest.content }] : []),
      ],
    } : null;
    if (options.authorizer) {
      const decision = await options.authorizer.authorize({ ...detail.run, runId: data.runId });
      if (!decision.allowed) {
        await record({ ...(!isTerminalRunStatus(detail.run.status) ? { status: "NEEDS_HUMAN" as const } : {}), failureClassification: "VERIFIED_UNDELIVERED", kind: "delivery.permission-denied", reason: "Actor no longer meets repository permission policy; publishing is blocked" });
        return { outcome: "permission-denied" };
      }
    }
    if (detail.run.status === "PUBLISHING" && !proposal) throw new Error("Missing delivery-eligible verified patch");
    if (detail.run.status === "PUBLISHING") await progress("Publishing", "Recorded execution evidence passed the delivery gate; DevSentinel is reconciling a draft pull request and status artifacts.");
    detail = (await getRunDetail(db, data.runId))!;
    await options.publisher.publish({
      detail,
      proposal,
      guard,
      save: (delivery) => record({ kind: "delivery.checkpoint", reason: "Saved reconciled delivery progress", delivery }),
    });
    await record({
      ...(detail.run.status === "PUBLISHING" ? { status: "SUCCEEDED" as const, failureClassification: null } : {}),
      kind: "delivery.completed",
      reason: proposal ? "Verified issue-scoped repair delivered; human review is required" : detail.run.statusReason ?? "Result delivered",
      delivered: true,
    });
    const completed = (await getRunDetail(db, data.runId))!;
    return {
      outcome: "completed",
      status: completed.run.status,
      deliveryMode: completed.workflow?.delivery.mode ?? "not-recorded",
    };
  } finally {
    clearInterval(heartbeat);
    abort.abort();
    await releaseWorkflow(db, data.runId, owner);
  }
}
