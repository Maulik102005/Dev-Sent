import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { dispatchOutboxBatch } from "@devsentinel/dispatcher";
import {
  createDatabase,
  ingestWebhook,
  migrateDatabase,
  outboxEvents,
  runs,
  sandboxExecutions,
} from "@devsentinel/database";
import type { RunMode, RunStatus } from "@devsentinel/domain";
import {
  authorizationQueueName,
  baselineQueueName,
  BullMqOutboxJobPublisher,
  createAuthorizationQueue,
  createBaselineQueue,
} from "@devsentinel/queue";
import type {
  BaselineExecutionRequest,
  BaselineExecutionResult,
  BaselineSandbox,
} from "@devsentinel/sandbox";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { DevelopmentAllowAllAuthorizer } from "./authorization.js";
import { createBaselineWorker } from "./baseline-worker.js";
import { processAuthorizationJob } from "./process-authorization.js";
import { LocalDirectoryRepositorySource } from "./repository-source.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const databaseUrl = process.env.TEST_DATABASE_URL!;
const redisUrl = process.env.TEST_REDIS_URL!;
const database = createDatabase(databaseUrl);
const cleanup: Array<() => Promise<void>> = [];

class RecordingSandbox implements BaselineSandbox {
  readonly requests: BaselineExecutionRequest[] = [];
  workspacePath: string | null = null;

  constructor(private readonly result: BaselineExecutionResult) {}

  async executeBaseline(
    request: BaselineExecutionRequest,
  ): Promise<BaselineExecutionResult> {
    this.requests.push(request);
    this.workspacePath = request.workspacePath;
    await access(request.workspacePath);
    return this.result;
  }
}

function commandResult(
  command: readonly string[],
  exitCode: number | null,
  options: { timedOut?: boolean; stdout?: string; stderr?: string } = {},
) {
  return {
    command,
    exitCode,
    timedOut: options.timedOut ?? false,
    durationMs: 25,
    stdout: options.stdout ?? "",
    stderr: options.stderr ?? "",
    outputTruncated: false,
  };
}

function baselineResult(input: {
  testExitCode: number | null;
  testTimedOut?: boolean;
}): BaselineExecutionResult {
  return {
    image: "node:test-fixture",
    install: commandResult(
      ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      0,
      { stdout: "installed" },
    ),
    test: commandResult(["npm", "test"], input.testExitCode, {
      ...(input.testTimedOut === undefined
        ? {}
        : { timedOut: input.testTimedOut }),
      stdout: "test evidence",
    }),
  };
}

async function createAuthorizedRun(mode: RunMode) {
  const ingested = await ingestWebhook(database.db, {
    deliveryId: randomUUID(),
    eventName: "issues",
    action: "labeled",
    payload: { fixture: true },
    trigger: {
      installationId: 901,
      repositoryId: 501,
      repositoryFullName: "octocat/hello-world",
      defaultBranch: "main",
      issueNumber: 42,
      actorLogin: "maintainer",
      activation: "label",
      mode,
    },
  });

  if (ingested.kind !== "accepted") {
    throw new Error(`Expected accepted run, received ${ingested.kind}`);
  }

  const [authorizationEvent] = await database.db
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, ingested.runId));

  if (!authorizationEvent) {
    throw new Error("Expected authorization outbox event");
  }

  await processAuthorizationJob(database.db, new DevelopmentAllowAllAuthorizer(), {
    runId: ingested.runId,
    outboxEventId: authorizationEvent.id,
    mode,
  });

  return ingested.runId;
}

async function waitForStatus(
  runId: string,
  expected: RunStatus,
): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const [run] = await database.db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId));

    if (run?.status === expected) {
      return;
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }

  throw new Error(`Run ${runId} did not reach ${expected}`);
}

async function executePipeline(mode: RunMode, result: BaselineExecutionResult) {
  const runId = await createAuthorizedRun(mode);
  const authorizationTestQueueName = `${authorizationQueueName}-${randomUUID()}`;
  const baselineTestQueueName = `${baselineQueueName}-${randomUUID()}`;
  const authorizationQueue = createAuthorizationQueue(
    redisUrl,
    authorizationTestQueueName,
  );
  const baselineQueue = createBaselineQueue(redisUrl, baselineTestQueueName);
  const publisher = new BullMqOutboxJobPublisher(
    authorizationQueue,
    baselineQueue,
  );
  const sandbox = new RecordingSandbox(result);
  const worker = createBaselineWorker({
    db: database.db,
    redisUrl,
    repositorySource: new LocalDirectoryRepositorySource(
      resolve(workspaceRoot, "fixtures/sandbox/passing-node"),
    ),
    sandbox,
    queueName: baselineTestQueueName,
  });
  worker.on("error", () => undefined);
  await worker.waitUntilReady();

  cleanup.push(async () => {
    await worker.close();
    await authorizationQueue.obliterate({ force: true });
    await baselineQueue.obliterate({ force: true });
    await publisher.close();
  });

  const dispatched = await dispatchOutboxBatch({
    db: database.db,
    publisher,
    ownerId: `baseline-integration-${randomUUID()}`,
  });

  expect(dispatched).toEqual({ claimed: 2, published: 2, failed: 0 });
  return { runId, sandbox };
}

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await database.client.unsafe(
    "TRUNCATE TABLE sandbox_executions, outbox_events, runs, webhook_deliveries CASCADE",
  );
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

afterAll(async () => {
  await database.client.unsafe(
    "TRUNCATE TABLE sandbox_executions, outbox_events, runs, webhook_deliveries CASCADE",
  );
  await database.close();
});

describe("baseline pipeline", () => {
  it("records a TEST success, exact snapshot identity, evidence, and cleanup", async () => {
    const { runId, sandbox } = await executePipeline(
      "TEST",
      baselineResult({ testExitCode: 0 }),
    );
    await waitForStatus(runId, "SUCCEEDED");

    const [run] = await database.db
      .select({
        status: runs.status,
        commitSha: runs.targetCommitSha,
        packageManager: runs.detectedPackageManager,
        reason: runs.statusReason,
        completedAt: runs.baselineCompletedAt,
      })
      .from(runs)
      .where(eq(runs.id, runId));
    const executions = await database.db
      .select()
      .from(sandboxExecutions)
      .where(eq(sandboxExecutions.runId, runId));

    expect(run).toMatchObject({
      status: "SUCCEEDED",
      packageManager: "npm",
      reason: "Baseline test suite passed",
    });
    expect(run?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(run?.completedAt).toBeInstanceOf(Date);
    expect(executions).toHaveLength(2);
    expect(executions.map((execution) => execution.phase).sort()).toEqual([
      "BASELINE_TEST",
      "DEPENDENCY_INSTALL",
    ]);
    expect(executions.find((execution) => execution.phase === "BASELINE_TEST"))
      .toMatchObject({ exitCode: 0, stdout: "test evidence" });
    expect(sandbox.workspacePath).not.toBeNull();
    await expect(access(sandbox.workspacePath!)).rejects.toThrow();
  });

  it("moves a reproducible FIX failure forward to diagnosis", async () => {
    const { runId } = await executePipeline(
      "FIX",
      baselineResult({ testExitCode: 1 }),
    );
    await waitForStatus(runId, "DIAGNOSING");

    const [run] = await database.db
      .select({ status: runs.status, reason: runs.statusReason })
      .from(runs)
      .where(eq(runs.id, runId));

    expect(run).toEqual({
      status: "DIAGNOSING",
      reason: "Baseline failure reproduced with exit code 1",
    });
  });

  it("moves a green FIX baseline to diagnosis so a frozen reproducer can be required", async () => {
    const { runId } = await executePipeline(
      "FIX",
      baselineResult({ testExitCode: 0 }),
    );
    await waitForStatus(runId, "DIAGNOSING");
  });

  it("records a test timeout as a controlled failure", async () => {
    const { runId } = await executePipeline(
      "TEST",
      baselineResult({ testExitCode: null, testTimedOut: true }),
    );
    await waitForStatus(runId, "FAILED");

    const [testExecution] = await database.db
      .select({ timedOut: sandboxExecutions.timedOut })
      .from(sandboxExecutions)
      .where(eq(sandboxExecutions.phase, "BASELINE_TEST"));

    expect(testExecution?.timedOut).toBe(true);
  });
});
