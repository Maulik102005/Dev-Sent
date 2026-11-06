import { count } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  migrateDatabase,
  outboxEvents,
  runClarifications,
  runTaskBriefs,
  runWorkflows,
  runs,
  webhookDeliveries,
} from "@devsentinel/database";
import { eq } from "drizzle-orm";

import { buildApp } from "./app.js";
import { signGitHubPayload } from "./github-signature.js";

const databaseUrl = process.env.TEST_DATABASE_URL!;
const webhookSecret = "integration-test-webhook-secret";
const database = createDatabase(databaseUrl);
const app = buildApp({ db: database.db, webhookSecret });

const triggerPayload = {
  action: "labeled",
  installation: { id: 901 },
  repository: {
    id: 501,
    full_name: "octocat/hello-world",
    default_branch: "main",
  },
  sender: { login: "maintainer" },
  issue: { number: 42 },
  label: { name: "devsentinel:fix" },
};

function webhookRequest(deliveryId: string, payload = triggerPayload) {
  const body = Buffer.from(JSON.stringify(payload));

  return {
    method: "POST" as const,
    url: "/webhooks/github",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "issues",
      "x-hub-signature-256": signGitHubPayload(body, webhookSecret),
    },
    payload: body,
  };
}

function commentRequest(deliveryId: string, payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    method: "POST" as const,
    url: "/webhooks/github",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "issue_comment",
      "x-hub-signature-256": signGitHubPayload(body, webhookSecret),
    },
    payload: body,
  };
}

beforeAll(async () => {
  await migrateDatabase(database.db);
  await app.ready();
});

beforeEach(async () => {
  await database.client.unsafe(
    "TRUNCATE TABLE outbox_events, runs, webhook_deliveries CASCADE",
  );
});

afterAll(async () => {
  await app.close();
  await database.client.unsafe(
    "TRUNCATE TABLE outbox_events, runs, webhook_deliveries CASCADE",
  );
  await database.close();
});

describe("POST /webhooks/github", () => {
  it("atomically creates a delivery, run, and outbox event", async () => {
    const response = await app.inject(webhookRequest("delivery-first"));

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: true,
      mode: "FIX",
      status: "AUTHORIZING",
    });

    const [deliveryCount] = await database.db
      .select({ value: count() })
      .from(webhookDeliveries);
    const [runCount] = await database.db
      .select({ value: count() })
      .from(runs);
    const [outboxCount] = await database.db
      .select({ value: count() })
      .from(outboxEvents);

    expect(deliveryCount?.value).toBe(1);
    expect(runCount?.value).toBe(1);
    expect(outboxCount?.value).toBe(1);
    const [brief] = await database.db.select().from(runTaskBriefs);
    expect(brief).toMatchObject({
      authorizedActor: "maintainer",
      requestedOutcome: "Resolve the reported behavior in issue #42",
      constraints: ["Issue-scoped work only; unrelated failures and improvements are excluded"],
    });
  });

  it("persists structured command context and resumes only an authorized exact continuation without resetting budgets", async () => {
    const issue = {
      id: 420,
      number: 42,
      title: "Checkout total is wrong",
      body: "- [ ] Quantity three produces the expected total",
      created_at: "2026-09-10T00:00:00Z",
      updated_at: "2026-09-10T01:00:00Z",
    };
    const trigger = await app.inject(commentRequest("delivery-context", {
      action: "created",
      installation: { id: 901 },
      repository: { id: 501, full_name: "octocat/hello-world", default_branch: "main" },
      sender: { login: "maintainer" },
      issue,
      comment: { id: 700, created_at: "2026-09-10T01:00:00Z", body: "/devsentinel fix\nOutcome: Correct quantity totals\nAcceptance: Three items use three unit prices\nConstraint: Do not change shipping\nScope: src/checkout.js\nExclude: src/shipping.js" },
    }));
    expect(trigger.statusCode).toBe(202);
    const runId = trigger.json().runId as string;
    const [brief] = await database.db.select().from(runTaskBriefs).where(eq(runTaskBriefs.runId, runId));
    expect(brief).toMatchObject({
      requestedOutcome: "Correct quantity totals",
      acceptanceCriteria: ["Three items use three unit prices"],
      approvedPaths: ["src/checkout.js"],
      excludedPaths: ["src/shipping.js"],
      authorizedActor: "maintainer",
      source: expect.objectContaining({ commentId: "700", deliveryId: "delivery-context" }),
    });
    await database.db.update(runs).set({ status: "AWAITING_CLARIFICATION" }).where(eq(runs.id, runId));
    await database.db.insert(runWorkflows).values({ runId, reservedTokens: 1200, toolCallCount: 4, toolOutputBytes: 2048 });
    await database.db.insert(runClarifications).values({ runId, question: "Which boundary is intended?", deadlineAt: new Date(Date.now() + 60_000) });

    const continuationPayload = (actor: string, answer: string) => ({
      action: "created",
      installation: { id: 901 },
      repository: { id: 501, full_name: "octocat/hello-world", default_branch: "main" },
      sender: { login: actor }, issue,
      comment: { id: actor === "maintainer" ? 702 : 701, created_at: "2026-09-10T01:01:00Z", body: `/devsentinel continue ${runId} ${answer}` },
    });
    const unauthorized = await app.inject(commentRequest("delivery-context-wrong-actor", continuationPayload("outsider", "Use inclusive boundary")));
    expect(unauthorized.json()).toMatchObject({ ignored: true });
    const accepted = await app.inject(commentRequest("delivery-context-answer", continuationPayload("maintainer", "Use inclusive boundary")));
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ continuation: true, runId, status: "DIAGNOSING" });
    const [workflow] = await database.db.select().from(runWorkflows).where(eq(runWorkflows.runId, runId));
    const [clarification] = await database.db.select().from(runClarifications).where(eq(runClarifications.runId, runId));
    expect(workflow).toMatchObject({ reservedTokens: 1200, toolCallCount: 4, toolOutputBytes: 2048 });
    expect(clarification).toMatchObject({ status: "ANSWERED", answer: "Use inclusive boundary", answeredBy: "maintainer", answerDeliveryId: "delivery-context-answer" });
  });

  it("creates a TEST run for the test label", async () => {
    const response = await app.inject(
      webhookRequest("delivery-test-mode", {
        ...triggerPayload,
        label: { name: "devsentinel:test" },
      }),
    );

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ mode: "TEST" });

    const [run] = await database.db
      .select({ mode: runs.mode })
      .from(runs);

    expect(run?.mode).toBe("TEST");
  });

  it("turns ten concurrent duplicate deliveries into exactly one run", async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject(webhookRequest("delivery-duplicate")),
      ),
    );

    expect(responses.filter((response) => response.statusCode === 202)).toHaveLength(
      1,
    );
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(
      9,
    );

    const [runCount] = await database.db
      .select({ value: count() })
      .from(runs);
    const [outboxCount] = await database.db
      .select({ value: count() })
      .from(outboxEvents);

    expect(runCount?.value).toBe(1);
    expect(outboxCount?.value).toBe(1);
  });

  it("rejects a forged signature without persisting the delivery", async () => {
    const request = webhookRequest("delivery-forged");
    request.headers["x-hub-signature-256"] = "sha256=not-a-valid-signature";

    const response = await app.inject(request);

    expect(response.statusCode).toBe(401);

    const [deliveryCount] = await database.db
      .select({ value: count() })
      .from(webhookDeliveries);

    expect(deliveryCount?.value).toBe(0);
  });

  it("records but does not create a run for unrelated labels", async () => {
    const response = await app.inject(
      webhookRequest("delivery-ignored", {
        ...triggerPayload,
        label: { name: "bug" },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ignored: true });

    const [deliveryCount] = await database.db
      .select({ value: count() })
      .from(webhookDeliveries);
    const [runCount] = await database.db
      .select({ value: count() })
      .from(runs);

    expect(deliveryCount?.value).toBe(1);
    expect(runCount?.value).toBe(0);
  });
});
