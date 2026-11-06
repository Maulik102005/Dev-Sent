import { randomUUID } from "node:crypto";

import { dispatchOutboxBatch } from "@devsentinel/dispatcher";
import {
  createDatabase,
  ingestWebhook,
  migrateDatabase,
  outboxEvents,
  runs,
} from "@devsentinel/database";
import {
  authorizationQueueName,
  authorizationJobName,
  baselineQueueName,
  BullMqOutboxJobPublisher,
  createAuthorizationQueue,
  createBaselineQueue,
  type OutboxJobPublisher,
  type PublishableOutboxEvent,
} from "@devsentinel/queue";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  AuthorizationDecision,
  AuthorizationTarget,
  RunAuthorizer,
} from "./authorization.js";
import { GitHubAppAuthorizer } from "./github-app-authorizer.js";
import { processAuthorizationJob } from "./process-authorization.js";
import { createAuthorizationWorker } from "./worker.js";

const databaseUrl = process.env.TEST_DATABASE_URL!;
const redisUrl = process.env.TEST_REDIS_URL!;
const database = createDatabase(databaseUrl);
const cleanup: Array<() => Promise<void>> = [];

class CountingAuthorizer implements RunAuthorizer {
  calls = 0;

  constructor(private readonly decision: AuthorizationDecision) {}

  async authorize(_target: AuthorizationTarget): Promise<AuthorizationDecision> {
    this.calls += 1;
    return this.decision;
  }
}

async function createRun(mode: "TEST" | "FIX") {
  const result = await ingestWebhook(database.db, {
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

  if (result.kind !== "accepted") {
    throw new Error(`Expected accepted run, received ${result.kind}`);
  }

  const [event] = await database.db
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, result.runId));

  if (!event) {
    throw new Error("Expected authorization outbox event");
  }

  return { runId: result.runId, outboxEventId: event.id };
}

async function waitForRunStatus(
  runId: string,
  expected: "PREPARING" | "REJECTED" | "FAILED",
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

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Run ${runId} did not reach ${expected}`);
}

async function createPipeline(authorizer: RunAuthorizer) {
  const queueName = `${authorizationQueueName}-${randomUUID()}`;
  const baselineTestQueueName = `${baselineQueueName}-${randomUUID()}`;
  const queue = createAuthorizationQueue(redisUrl, queueName);
  const baselineQueue = createBaselineQueue(redisUrl, baselineTestQueueName);
  const publisher = new BullMqOutboxJobPublisher(queue, baselineQueue);
  const worker = createAuthorizationWorker({
    db: database.db,
    redisUrl,
    authorizer,
    queueName,
    concurrency: 2,
  });
  worker.on("error", () => undefined);
  await worker.waitUntilReady();

  cleanup.push(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await baselineQueue.obliterate({ force: true });
    await publisher.close();
  });

  return { publisher, queue };
}

beforeAll(async () => {
  await migrateDatabase(database.db);
});

beforeEach(async () => {
  await database.client.unsafe(
    "TRUNCATE TABLE outbox_events, runs, webhook_deliveries CASCADE",
  );
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

afterAll(async () => {
  await database.client.unsafe(
    "TRUNCATE TABLE outbox_events, runs, webhook_deliveries CASCADE",
  );
  await database.close();
});

describe("authorization pipeline", () => {
  it("dispatches a TEST run through Redis and advances it idempotently", async () => {
    const authorizer = new CountingAuthorizer({
      allowed: true,
      reason: "allowed by integration test",
    });
    const { publisher } = await createPipeline(authorizer);
    const created = await createRun("TEST");

    const dispatched = await dispatchOutboxBatch({
      db: database.db,
      publisher,
      ownerId: "integration-dispatcher",
    });

    expect(dispatched).toEqual({ claimed: 1, published: 1, failed: 0 });
    await waitForRunStatus(created.runId, "PREPARING");

    const [run] = await database.db
      .select({
        mode: runs.mode,
        status: runs.status,
        reason: runs.authorizationReason,
        version: runs.version,
      })
      .from(runs)
      .where(eq(runs.id, created.runId));
    const [event] = await database.db
      .select({
        publishedAt: outboxEvents.publishedAt,
        attempts: outboxEvents.attempts,
      })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, created.outboxEventId));

    expect(run).toMatchObject({
      mode: "TEST",
      status: "PREPARING",
      reason: "allowed by integration test",
      version: 1,
    });
    expect(event?.publishedAt).toBeInstanceOf(Date);
    expect(event?.attempts).toBe(1);
    expect(authorizer.calls).toBe(1);

    const repeated = await processAuthorizationJob(database.db, authorizer, {
      runId: created.runId,
      outboxEventId: created.outboxEventId,
      mode: "TEST",
    });

    expect(repeated).toEqual({
      outcome: "already-processed",
      status: "PREPARING",
    });
    expect(authorizer.calls).toBe(1);
  });

  it("recovers when publication succeeds but marking the outbox row fails", async () => {
    const authorizer = new CountingAuthorizer({
      allowed: true,
      reason: "allowed after simulated dispatcher crash",
    });
    const { publisher } = await createPipeline(authorizer);
    const created = await createRun("FIX");
    let simulateCrash = true;
    const crashAfterPublish: OutboxJobPublisher = {
      async publish(event: PublishableOutboxEvent): Promise<void> {
        await publisher.publish(event);

        if (simulateCrash) {
          simulateCrash = false;
          throw new Error("simulated crash after Redis accepted the job");
        }
      },
      async close(): Promise<void> {},
    };

    const firstAttempt = await dispatchOutboxBatch({
      db: database.db,
      publisher: crashAfterPublish,
      ownerId: "dispatcher-before-crash",
      retryBaseMs: 0,
    });

    expect(firstAttempt).toEqual({ claimed: 1, published: 0, failed: 1 });
    await waitForRunStatus(created.runId, "PREPARING");

    const retry = await dispatchOutboxBatch({
      db: database.db,
      publisher,
      ownerId: "dispatcher-after-crash",
      batchSize: 1,
      retryBaseMs: 0,
    });

    expect(retry).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(authorizer.calls).toBe(1);

    const [event] = await database.db
      .select({
        attempts: outboxEvents.attempts,
        publishedAt: outboxEvents.publishedAt,
        lastError: outboxEvents.lastError,
      })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, created.outboxEventId));

    expect(event?.attempts).toBe(2);
    expect(event?.publishedAt).toBeInstanceOf(Date);
    expect(event?.lastError).toBeNull();
  });

  it("records a denied authorization as REJECTED", async () => {
    const authorizer = new GitHubAppAuthorizer(
      {
        async getToken() {
          return "integration-installation-token";
        },
      },
      {
        async getPermission() {
          return { permission: "read" as const, roleName: "triage" };
        },
      },
      { TEST: "write", FIX: "write" },
    );
    const { publisher } = await createPipeline(authorizer);
    const created = await createRun("FIX");

    await dispatchOutboxBatch({
      db: database.db,
      publisher,
      ownerId: "integration-dispatcher",
    });
    await waitForRunStatus(created.runId, "REJECTED");

    const [run] = await database.db
      .select({
        status: runs.status,
        reason: runs.authorizationReason,
      })
      .from(runs)
      .where(eq(runs.id, created.runId));

    expect(run).toEqual({
      status: "REJECTED",
      reason:
        "GitHub permission read (role: triage) does not meet required write permission for FIX",
    });
  });

  it("marks authorization FAILED after the final retry and redacts tokens", async () => {
    const authorizer: RunAuthorizer = {
      async authorize() {
        throw new Error("Bearer ghs_never_store_this_token was rejected");
      },
    };
    const { queue } = await createPipeline(authorizer);
    const created = await createRun("FIX");

    await queue.add(
      authorizationJobName,
      {
        runId: created.runId,
        outboxEventId: created.outboxEventId,
        mode: "FIX",
      },
      { attempts: 1 },
    );
    await waitForRunStatus(created.runId, "FAILED");

    const [run] = await database.db
      .select({ status: runs.status, reason: runs.authorizationReason })
      .from(runs)
      .where(eq(runs.id, created.runId));

    expect(run?.status).toBe("FAILED");
    expect(run?.reason).toContain("Authorization failed after 1 attempt(s)");
    expect(run?.reason).toContain("[REDACTED]");
    expect(run?.reason).not.toContain("ghs_never_store_this_token");
  });
});
