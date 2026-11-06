import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  answerClarificationAsOperator, assertWorkflow, cancelRun, checkpoint, claimWorkflow, completeRunAuthorization,
  createDatabase, getRunDetail, ingestWebhook, migrateDatabase, outboxEvents,
  recordWorkflowFailure, releaseWorkflow, requestRunRecovery, reserveAttempt, runs, runClarifications, runWorkflows,
  claimOutboxEvents, releaseOutboxEvent,
} from "@devsentinel/database";
import { DockerSandboxExecutor, type BaselineSandbox } from "@devsentinel/sandbox";
import { createFollowupQueue, followupQueueName } from "@devsentinel/queue";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { processBaselineJob } from "./process-baseline.js";
import { defaultFollowupPolicy, processFollowupJob } from "./process-followup.js";
import { DryRunPublisher } from "./github-delivery.js";
import { LocalDirectoryRepositorySource, type RepositorySource } from "./repository-source.js";
import { OpenAIRepairModel, type RepairModel } from "./repair-model.js";
import { createFollowupWorker } from "./followup-worker.js";

const database = createDatabase(process.env.TEST_DATABASE_URL!);
const repo = "example/checkout";
const source = new LocalDirectoryRepositorySource(resolve("fixtures/sandbox/repair-node"));
const publisher = new DryRunPublisher();
const policy = { ...defaultFollowupPolicy, allowedRepositories: [repo] };
const goodProposal = { summary: "Multiply unit price by quantity to calculate the order total.", edits: [{ path: "src/total.js", content: "export function total(price, quantity) { return price * quantity; }\n" }] };
const model: RepairModel = { propose: async () => ({ proposal: goodProposal, inputTokens: 100, outputTokens: 50 }) };
const command = (exitCode: number) => ({ command: ["npm", "test"], exitCode, timedOut: false, durationMs: 1, stdout: "test output", stderr: "", outputTruncated: false });
const fakeSandbox = (exitCode: number): BaselineSandbox => ({ executeBaseline: async () => ({ image: "test", install: command(0), test: command(exitCode) }) });
const options = { db: database.db, repositorySource: source, sandbox: fakeSandbox(0), model, publisher, policy };
async function run(
  mode: "TEST" | "FIX" = "FIX",
  realBaseline = false,
  baselineExitCode = 1,
  repositorySource: RepositorySource = source,
) {
  const result = await ingestWebhook(database.db, { deliveryId: randomUUID(), eventName: "issue_comment", action: "created", payload: { issue: { title: "Order total is wrong", body: "500 cents times 3 items should be 1500 cents." } },
    trigger: { installationId: 1, repositoryId: 2, repositoryFullName: repo, defaultBranch: "main", issueNumber: 1, actorLogin: "owner", activation: "command", mode } });
  if (result.kind !== "accepted") throw new Error("Fixture ingestion failed");
  await completeRunAuthorization(database.db, { runId: result.runId, allowed: true, reason: "test actor" });
  const data = { runId: result.runId, mode, outboxEventId: randomUUID() };
  await processBaselineJob(database.db, repositorySource, realBaseline ? new DockerSandboxExecutor() : fakeSandbox(baselineExitCode), data);
  return data;
}
beforeAll(async () => migrateDatabase(database.db));
beforeEach(async () => { await database.client.unsafe("TRUNCATE sandbox_executions, outbox_events, runs, webhook_deliveries CASCADE"); });
afterAll(async () => database.close());

describe("bounded repair and durable delivery", () => {
  it("persists incomplete diagnostics and usage, then stops without buying the same request again", async () => {
    const data = await run();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      id: "resp_incomplete", status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      usage: { input_tokens: 123, output_tokens: 4096 },
    }, { headers: { "x-request-id": "req_incomplete" } }));
    const liveAdapter = new OpenAIRepairModel({ apiKey: "test-only", model: "test-only", maxOutputTokens: 4096, fetchImplementation: fetcher });
    const sandbox = { executeBaseline: vi.fn<BaselineSandbox["executeBaseline"]>() };
    const config = { ...options, model: liveAdapter, sandbox };
    await processFollowupJob(config, data);
    const detail = (await getRunDetail(database.db, data.runId))!;
    expect(detail.run.status).toBe("NEEDS_HUMAN");
    expect(detail.run.statusReason).toContain("max_output_tokens");
    expect(detail.attempts[0]).toMatchObject({ status: "INCOMPLETE", inputTokens: 123, outputTokens: 4096,
      modelDiagnostics: { kind: "incomplete", responseId: "resp_incomplete", requestId: "req_incomplete", retryable: false } });
    expect(detail.workflow!.reservedTokens).toBe(detail.attempts[0]!.reservedTokens);
    expect(detail.workflow!.delivery.summary).toContain("123 input / 4096 output tokens");
    await processFollowupJob(config, data);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sandbox.executeBaseline).not.toHaveBeenCalled();
  });
  it("preserves transient failure diagnostics across recovery without marking them interrupted or refunding", async () => {
    const data = await run();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: "server_error", message: "private provider details" } }, { status: 503, headers: { "x-request-id": "req_outage" } }))
      .mockResolvedValueOnce(Response.json({ id: "resp_recovered", status: "completed", usage: { input_tokens: 100, output_tokens: 50 },
        output: [{ content: [{ type: "output_text", text: JSON.stringify(goodProposal) }] }] }));
    const config = { ...options, model: new OpenAIRepairModel({ apiKey: "test-only", model: "test-only", maxOutputTokens: 4096, fetchImplementation: fetcher }) };
    await expect(processFollowupJob(config, data)).rejects.toThrow("Model api_error (HTTP 503): server_error");
    const first = (await getRunDetail(database.db, data.runId))!;
    expect(first.attempts[0]).toMatchObject({ status: "API_ERROR", inputTokens: null, outputTokens: null,
      modelDiagnostics: { requestId: "req_outage", httpStatus: 503, retryable: true } });
    await processFollowupJob(config, data);
    const detail = (await getRunDetail(database.db, data.runId))!;
    expect(detail.run.status).toBe("SUCCEEDED");
    expect(detail.attempts.map((a) => a.status)).toEqual(["API_ERROR", "VERIFIED"]);
    expect(detail.attempts[1]?.modelDiagnostics).toMatchObject({ kind: "completed", responseId: "resp_recovered" });
    expect(detail.workflow!.reservedTokens).toBe(detail.attempts.reduce((sum, a) => sum + a.reservedTokens, 0));
    expect(detail.workflow!.reservedTokens).toBeGreaterThan(first.workflow!.reservedTokens);
    expect(detail.workflow!.delivery.summary).toContain("1 attempt(s) have unknown usage");
    expect(JSON.stringify(detail)).not.toContain("private provider details");
  });
  it("keeps transient retries within the repair attempt cap", async () => {
    const data = await run();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 }));
    const config = { ...options, policy: { ...policy, maxAttempts: 1 }, model: new OpenAIRepairModel({ apiKey: "test-only", model: "test-only", maxOutputTokens: 4096, fetchImplementation: fetcher }) };
    await expect(processFollowupJob(config, data)).rejects.toThrow("HTTP 429");
    const reserved = (await getRunDetail(database.db, data.runId))!.workflow!.reservedTokens;
    await processFollowupJob(config, data);
    const detail = (await getRunDetail(database.db, data.runId))!;
    expect(detail.run.status).toBe("BUDGET_EXHAUSTED");
    expect(detail.workflow!.reservedTokens).toBe(reserved);
    expect(detail.attempts[0]!.modelDiagnostics!.reason).toBe("rate_limit_exceeded");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("dead-letters outbox publication after ten failures without deleting evidence", async () => {
    const data = await run();
    await database.db.update(outboxEvents).set({ attempts: 9 }).where(eq(outboxEvents.aggregateId, data.runId));
    const claimed = await claimOutboxEvents(database.db, { ownerId: "test-dispatcher" });
    for (const event of claimed) await releaseOutboxEvent(database.db, { eventId: event.id, ownerId: "test-dispatcher", error: "queue unavailable", retryAt: new Date(0) });
    expect(await claimOutboxEvents(database.db, { ownerId: "test-dispatcher" })).toHaveLength(0);
    const detail = (await getRunDetail(database.db, data.runId))!;
    expect(detail.outbox.every((event) => event.deadLetteredAt && event.lastError === "queue unavailable")).toBe(true);
    expect(await requestRunRecovery(database.db, data.runId)).toBe(true);
    expect(await claimOutboxEvents(database.db, { ownerId: "test-dispatcher" })).toHaveLength(1);
  });
  it("repairs a genuine Docker failure, records evidence, and is idempotent on redelivery", async () => {
    const data = await run("FIX", true);
    expect((await getRunDetail(database.db, data.runId))?.run.status).toBe("DIAGNOSING");
    const observed = vi.spyOn(model, "propose");
    await processFollowupJob({ ...options, sandbox: new DockerSandboxExecutor() }, data);
    const detail = (await getRunDetail(database.db, data.runId))!;
    expect(detail.run.status).toBe("SUCCEEDED");
    expect(detail.attempts[0]?.verification?.test).toMatchObject({ exitCode: 0, timedOut: false });
    expect(detail.attempts[0]?.verification?.test?.stdout).toContain("# pass 1");
    expect(detail.workflow?.delivery.mode).toBe("dry-run");
    expect(detail.workflow?.deliveryCompletedAt).toBeInstanceOf(Date);
    await processFollowupJob(options, data);
    expect(observed).toHaveBeenCalledTimes(1);
    observed.mockRestore();
  });
  it("feeds failed verification into a second cumulative proposal", async () => {
    const data = await run();
    const firstProposal = { summary: "Try an incomplete quantity adjustment before correcting the calculation.", edits: [{ path: "src/total.js", content: "export function total(price, quantity) { return price * (quantity - 1); }\n" }] };
    const propose = vi.fn<RepairModel["propose"]>()
      .mockResolvedValueOnce({ proposal: firstProposal, inputTokens: 100, outputTokens: 50 })
      .mockResolvedValueOnce({ proposal: goodProposal, inputTokens: 100, outputTokens: 50 });
    const sandbox = { executeBaseline: vi.fn<BaselineSandbox["executeBaseline"]>().mockResolvedValueOnce({ image: "test", install: command(0), test: command(1) }).mockResolvedValue({ image: "test", install: command(0), test: command(0) }) };
    await processFollowupJob({ ...options, model: { propose }, sandbox }, data);
    const detail = (await getRunDetail(database.db, data.runId))!;
    expect(detail.run.status).toBe("SUCCEEDED");
    expect(detail.attempts.map((a) => a.status)).toEqual(["FAILED", "VERIFIED"]);
    expect(propose.mock.calls[1]?.[0].previous).toEqual(firstProposal);
  });
  it("stops at the attempt cap and does not refund uncertain model calls", async () => {
    const data = await run();
    const propose = vi.fn<RepairModel["propose"]>().mockRejectedValue(new Error("provider unavailable"));
    const limited = { ...options, model: { propose }, policy: { ...policy, maxAttempts: 1 } };
    await expect(processFollowupJob(limited, data)).rejects.toThrow("provider unavailable");
    const reserved = (await getRunDetail(database.db, data.runId))!.workflow!.reservedTokens;
    expect(reserved).toBeGreaterThan(0);
    await processFollowupJob(limited, data);
    expect((await getRunDetail(database.db, data.runId))?.run.status).toBe("BUDGET_EXHAUSTED");
    expect((await getRunDetail(database.db, data.runId))?.workflow?.reservedTokens).toBe(reserved);
    expect(propose).toHaveBeenCalledTimes(1);
  });
  it("stops before a model call when token or time limits are exhausted", async () => {
    const data = await run();
    const propose = vi.fn<RepairModel["propose"]>();
    await processFollowupJob({ ...options, model: { propose }, policy: { ...policy, maxTokens: 1 } }, data);
    expect((await getRunDetail(database.db, data.runId))?.run.status).toBe("BUDGET_EXHAUSTED");
    const next = await run();
    await database.db.insert(runWorkflows).values({ runId: next.runId, startedAt: new Date(0) });
    await processFollowupJob({ ...options, model: { propose } }, next);
    expect((await getRunDetail(database.db, next.runId))?.run.status).toBe("BUDGET_EXHAUSTED");
    expect(propose).not.toHaveBeenCalled();
  });
  it("does not grant an unreserved tool call after the durable tool budget is spent", async () => {
    const data = await run();
    const firstProposal = {
      summary: "Try an incomplete adjustment",
      edits: [{ path: "src/total.js", content: "export function total(price, quantity) { return price * (quantity - 1); }\n" }],
    };
    const propose = vi.fn<RepairModel["propose"]>()
      .mockResolvedValueOnce({ proposal: firstProposal, inputTokens: 10, outputTokens: 10 })
      .mockResolvedValueOnce({ proposal: goodProposal, inputTokens: 10, outputTokens: 10 });
    const sandbox = fakeSandbox(1);
    await processFollowupJob({
      ...options,
      model: { propose },
      sandbox,
      policy: { ...policy, maxAttempts: 2, maxToolCalls: 1, maxToolOutputBytes: 1_000 },
    }, data);
    const detail = (await getRunDetail(database.db, data.runId))!;
    expect(detail.run.status).toBe("BUDGET_EXHAUSTED");
    expect(detail.workflow).toMatchObject({ attemptCount: 1, toolCallCount: 1, toolOutputBytes: 500 });
    expect(propose).toHaveBeenCalledTimes(1);
  });
  it("preserves model and tool reservations across an authorized clarification continuation", async () => {
    const data = await run();
    const propose = vi.fn<RepairModel["propose"]>()
      .mockResolvedValueOnce({
        proposal: { summary: "Need the intended quantity boundary", edits: [] },
        clarification: "Should quantity zero be rejected or return a zero total?",
        plan: { suspectedCause: "Boundary intent is unclear", evidenceReferences: ["task:brief"], intendedFiles: ["src/total.js"], scopeExclusions: ["tests"], verificationSteps: ["Run full suite"] },
        inputTokens: 25, outputTokens: 10,
      })
      .mockResolvedValueOnce({ proposal: goodProposal, inputTokens: 30, outputTokens: 12 });
    const boundedPolicy = {
      ...policy,
      maxAttempts: 2,
      maxToolCalls: 6,
      maxToolOutputBytes: 6000,
      inputCostMicrousdPerMillion: 1_000_000,
      outputCostMicrousdPerMillion: 2_000_000,
    };
    await processFollowupJob({ ...options, model: { propose }, policy: boundedPolicy }, data);
    const paused = (await getRunDetail(database.db, data.runId))!;
    expect(paused.run.status).toBe("AWAITING_CLARIFICATION");
    expect(paused.workflow).toMatchObject({ attemptCount: 1, toolCallCount: 3, toolOutputBytes: 3000 });
    const now = Date.now();
    await database.db.update(runWorkflows).set({ startedAt: new Date(now - 30 * 60_000) })
      .where(eq(runWorkflows.runId, data.runId));
    await database.db.update(runClarifications).set({
      requestedAt: new Date(now - 29 * 60_000),
      deadlineAt: new Date(now + 60_000),
    }).where(eq(runClarifications.runId, data.runId));
    expect(await answerClarificationAsOperator(database.db, data.runId, "Quantity zero should return zero")).toBe(true);
    await processFollowupJob({ ...options, model: { propose }, policy: boundedPolicy }, data);
    const completed = (await getRunDetail(database.db, data.runId))!;
    expect(completed.run.status).toBe("SUCCEEDED");
    expect(completed.workflow).toMatchObject({ attemptCount: 2, toolCallCount: 6, toolOutputBytes: 6000 });
    expect(completed.clarifications[0]).toMatchObject({ status: "ANSWERED", answer: "Quantity zero should return zero" });
    expect(completed.attempts).toHaveLength(2);
    expect(completed.attempts.map((attempt) => attempt.estimatedCostMicrousd)).toEqual([45, 54]);
  });
  it("freezes a new regression test, proves failure before the source patch, then passes it and the full suite", async () => {
    const regressionSource = new LocalDirectoryRepositorySource(resolve("fixtures/sandbox/regression-node"));
    const data = await run("FIX", true, 1, regressionSource);
    const regressionContent = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/total.js';\ntest('quantity regression', () => assert.equal(total(500, 3), 1500));\n";
    const regressionTest = {
      summary: "Capture the missing quantity behavior",
      path: "test/quantity-regression.test.js",
      content: regressionContent,
      hash: createHash("sha256").update(regressionContent).digest("hex"),
    };
    await processFollowupJob({
      ...options,
      repositorySource: regressionSource,
      sandbox: new DockerSandboxExecutor(),
      policy: { ...policy, allowRegressionTests: true },
      model: { propose: async () => ({ proposal: goodProposal, regressionTest, inputTokens: 50, outputTokens: 25 }) },
    }, data);
    const detail = (await getRunDetail(database.db, data.runId))!;
    expect(detail.run.status).toBe("SUCCEEDED");
    expect(detail.executions.find((execution) => execution.phase === "BASELINE_TEST")).toMatchObject({ exitCode: 0, timedOut: false });
    expect(detail.attempts[0]).toMatchObject({
      status: "VERIFIED", deliveryEligible: true,
      regressionTest: expect.objectContaining({ path: regressionTest.path, hash: regressionTest.hash }),
      regressionBaseline: expect.objectContaining({ test: expect.objectContaining({ exitCode: 1, timedOut: false, stdout: expect.stringContaining("fail 1") }) }),
      regressionCandidate: expect.objectContaining({ test: expect.objectContaining({ exitCode: 0, timedOut: false, stdout: expect.stringContaining("pass 1") }) }),
      verification: expect.objectContaining({ test: expect.objectContaining({ exitCode: 0, timedOut: false, stdout: expect.stringContaining("pass 2") }) }),
      acceptanceEvidence: [expect.objectContaining({ status: "SUPPORTED", evidenceReferences: expect.arrayContaining(["regression-original-failure", "candidate-full-suite"]) })],
    });
  });
  it("recovers terminalized delivery without regenerating or retesting a verified patch", async () => {
    const data = await run();
    const publish = vi.fn().mockRejectedValueOnce(new Error("temporary delivery failure")).mockResolvedValue(undefined);
    const propose = vi.fn<RepairModel["propose"]>().mockResolvedValue({ proposal: goodProposal, inputTokens: 1, outputTokens: 1 });
    const sandbox = { executeBaseline: vi.fn<BaselineSandbox["executeBaseline"]>().mockResolvedValue({ image: "test", install: command(0), test: command(0) }) };
    const config = { ...options, model: { propose }, sandbox, publisher: { publish } };
    await expect(processFollowupJob(config, data)).rejects.toThrow("temporary delivery failure");
    expect((await getRunDetail(database.db, data.runId))?.run.status).toBe("PUBLISHING");
    await recordWorkflowFailure(database.db, data.runId, "delivery retries exhausted");
    expect((await getRunDetail(database.db, data.runId))?.run).toMatchObject({
      status: "NEEDS_HUMAN",
      failureClassification: "VERIFIED_UNDELIVERED",
    });
    expect(await requestRunRecovery(database.db, data.runId)).toBe(true);
    expect((await getRunDetail(database.db, data.runId))?.run.status).toBe("PUBLISHING");
    await processFollowupJob(config, data);
    expect(propose).toHaveBeenCalledTimes(1);
    expect(sandbox.executeBaseline).toHaveBeenCalledTimes(1);
    expect((await getRunDetail(database.db, data.runId))?.run.status).toBe("SUCCEEDED");
  });
  it("rejects test edits without running a verification container", async () => {
    const data = await run();
    const sandbox = { executeBaseline: vi.fn<BaselineSandbox["executeBaseline"]>() };
    await processFollowupJob({ ...options, sandbox, model: { propose: async () => ({ proposal: { summary: "disable test", edits: [{ path: "total.test.js", content: "// skip" }] }, inputTokens: 1, outputTokens: 1 }) } }, data);
    expect((await getRunDetail(database.db, data.runId))?.run.status).toBe("NEEDS_HUMAN");
    expect(sandbox.executeBaseline).not.toHaveBeenCalled();
  });
  it("rejects a zero-exit test run that changed the tests", async () => {
    const data = await run();
    const sandbox: BaselineSandbox = { executeBaseline: async (request) => {
      await writeFile(resolve(request.workspacePath, "total.test.js"), "// tampered");
      return { image: "test", install: command(0), test: command(0) };
    } };
    await processFollowupJob({ ...options, sandbox }, data);
    expect((await getRunDetail(database.db, data.runId))?.run.status).toBe("NEEDS_HUMAN");
    expect((await getRunDetail(database.db, data.runId))?.attempts[0]?.status).toBe("REJECTED");
  });
  it("does not invoke the model for TEST or an unapproved repository", async () => {
    const propose = vi.fn<RepairModel["propose"]>();
    const test = await run("TEST");
    await processFollowupJob({ ...options, model: { propose } }, test);
    const fix = await run();
    await processFollowupJob({ ...options, model: { propose }, policy: { ...policy, allowedRepositories: [] } }, fix);
    expect(propose).not.toHaveBeenCalled();
    expect((await getRunDetail(database.db, test.runId))?.run.status).toBe("FAILED");
    expect((await getRunDetail(database.db, fix.runId))?.run.status).toBe("NEEDS_HUMAN");
  });
  it("blocks side effects after cancellation and after permission revocation", async () => {
    const data = await run();
    const publish = vi.fn();
    const cancelModel: RepairModel = { propose: async () => { await cancelRun(database.db, data.runId); return { proposal: goodProposal, inputTokens: 1, outputTokens: 1 }; } };
    await expect(processFollowupJob({ ...options, model: cancelModel, publisher: { publish } }, data)).rejects.toThrow("cancelled");
    expect((await getRunDetail(database.db, data.runId))?.run.status).toBe("CANCELLED");
    expect(await requestRunRecovery(database.db, data.runId)).toBe(false);
    const second = await run();
    await processFollowupJob({ ...options, publisher: { publish }, authorizer: { authorize: async () => ({ allowed: false, reason: "revoked" }) } }, second);
    expect(publish).not.toHaveBeenCalled();
  });
  it("resumes saved proposals after a crash without purchasing another model response", async () => {
    const data = await run();
    const owner = randomUUID();
    await claimWorkflow(database.db, data.runId, owner);
    const attempt = await reserveAttempt(database.db, data.runId, owner, {
      tokens: 1000,
      maxTokens: 2000,
      maxAttempts: 1,
      maxDurationMs: 10000,
      toolCalls: 1,
      toolOutputBytes: 1_000,
      maxToolCalls: 1,
      maxToolOutputBytes: 1_000,
    });
    await checkpoint(database.db, data.runId, owner, { status: "PATCHING", kind: "fixture", reason: "saved before simulated crash", attemptId: attempt!.id, attempt: { proposal: goodProposal, status: "PROPOSED" } });
    await releaseWorkflow(database.db, data.runId, owner);
    const propose = vi.fn<RepairModel["propose"]>();
    await processFollowupJob({
      ...options,
      model: { propose },
      policy: { ...policy, maxAttempts: 1, maxToolCalls: 1, maxToolOutputBytes: 1_000 },
    }, data);
    expect(propose).not.toHaveBeenCalled();
    expect((await getRunDetail(database.db, data.runId))?.workflow).toMatchObject({ toolCallCount: 1, toolOutputBytes: 1_000 });
    expect((await getRunDetail(database.db, data.runId))?.run.status).toBe("SUCCEEDED");
  });
  it("allows only one lease owner and fences stale checkpoints after takeover", async () => {
    const data = await run();
    const first = randomUUID(), second = randomUUID();
    expect(await claimWorkflow(database.db, data.runId, first)).toBe(true);
    expect(await claimWorkflow(database.db, data.runId, second)).toBe(false);
    await database.db.update(runWorkflows).set({ leaseUntil: new Date(0) }).where(eq(runWorkflows.runId, data.runId));
    expect(await claimWorkflow(database.db, data.runId, second)).toBe(true);
    await expect(assertWorkflow(database.db, data.runId, first)).rejects.toThrow("lease lost");
    await expect(checkpoint(database.db, data.runId, first, { status: "SUCCEEDED", kind: "stale", reason: "not allowed" })).rejects.toThrow("lease lost");
    expect(await requestRunRecovery(database.db, data.runId)).toBe(false);
    await releaseWorkflow(database.db, data.runId, second);
  });
  it("persists a follow-up outbox event and processes the real BullMQ contract", async () => {
    const data = await run("TEST");
    const events = await database.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, data.runId));
    expect(events.some((event) => event.eventType === "run.followup.requested")).toBe(true);
    const queueName = `${followupQueueName}-${randomUUID()}`;
    const queue = createFollowupQueue(process.env.TEST_REDIS_URL!, queueName);
    const worker = createFollowupWorker({ ...options, queueName, redisUrl: process.env.TEST_REDIS_URL! });
    worker.on("error", () => undefined);
    try {
      await worker.waitUntilReady();
      await queue.add("followup-run", data);
      await vi.waitFor(async () => expect((await getRunDetail(database.db, data.runId))?.workflow?.deliveryCompletedAt).toBeInstanceOf(Date), { timeout: 5000 });
    } finally { await worker.close(); await queue.obliterate({ force: true }); await queue.close(); }
  });
});
