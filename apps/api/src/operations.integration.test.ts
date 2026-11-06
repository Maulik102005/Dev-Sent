import { createDatabase, getRunDetail, ingestWebhook, migrateDatabase } from "@devsentinel/database";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
const database = createDatabase(process.env.TEST_DATABASE_URL!);
const token = "test-control-token-at-least-32-characters";
const app = buildApp({ db: database.db, webhookSecret: "webhook-test-secret", controlToken: token });
let runId = "";
beforeAll(async () => {
  await migrateDatabase(database.db);
  const created = await ingestWebhook(database.db, {
    deliveryId: randomUUID(), eventName: "issues", action: "labeled", payload: { fixture: true },
    trigger: { installationId: 1, repositoryId: 2, repositoryFullName: "owner/repo", defaultBranch: "main", issueNumber: 3, actorLogin: "owner", activation: "label", mode: "FIX", issueTitle: "Boundary failure" },
  });
  if (created.kind !== "accepted") throw new Error("Run fixture was not created");
  runId = created.runId;
  await app.ready();
});
afterAll(async () => { await app.close(); await database.close(); });
describe("operator API", () => {
  it("keeps run data behind an independent bearer token", async () => {
    expect((await app.inject({ method: "GET", url: "/ops/runs" })).statusCode).toBe(401);
    const response = await app.inject({ method: "GET", url: "/ops/runs", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: expect.any(Array), total: expect.any(Number), limit: 30, offset: 0 });
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("disables control endpoints when no token is configured", async () => {
    const disabled = buildApp({ db: database.db, webhookSecret: "webhook-test-secret" });
    try { expect((await disabled.inject({ method: "GET", url: "/ops/runs", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(404); }
    finally { await disabled.close(); }
  });
  it("validates run IDs and refuses cross-site control requests", async () => {
    expect((await app.inject({ method: "GET", url: "/ops/runs/not-valid", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/ops/runs/00000000-0000-0000-0000-000000000000/cancel", headers: { authorization: `Bearer ${token}`, "sec-fetch-site": "cross-site" } })).statusCode).toBe(403);
  });
  it("requires explicit confirmation for every mutation", async () => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await app.inject({ method: "POST", url: `/ops/runs/${runId}/cancel`, headers, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/ops/runs/${runId}/retry`, headers, payload: { confirmed: false } })).statusCode).toBe(400);
    expect((await getRunDetail(database.db, runId))?.run.status).toBe("AUTHORIZING");
  });
  it("answers inspector questions from saved evidence without starting work", async () => {
    const response = await app.inject({ method: "POST", url: `/ops/runs/${runId}/inspect`, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { question: "Why did this fail?" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "FALLBACK_MODEL_DISABLED", evidenceReferences: expect.arrayContaining(["run:status"]) });
    const secretQuestion = await app.inject({ method: "POST", url: `/ops/runs/${runId}/inspect`, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { question: "Explain sk-123456789012345678901234 safely" } });
    expect(secretQuestion.statusCode).toBe(200);
    const detail = await getRunDetail(database.db, runId);
    expect(detail?.run.status).toBe("AUTHORIZING");
    expect(detail?.inspector).toHaveLength(2);
    expect(detail?.inspector[1]?.question).toContain("[REDACTED TOKEN]");
    expect(JSON.stringify(detail?.inspector)).not.toContain("sk-123456789012345678901234");
    expect(detail?.workflow).toMatchObject({ inspectorQueryCount: 2, reservedTokens: 0, attemptCount: 0 });
  });
  it("reports real readiness modes without returning credentials", async () => {
    const response = await app.inject({ method: "GET", url: "/ops/readiness", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ database: "ready", model: "disabled", inspector: "fallback", deliveryMode: "dry-run" });
    expect(response.body).not.toContain(token);
  });
  it("exposes durable metrics without high-cardinality repository labels", async () => {
    const response = await app.inject({ method: "GET", url: "/ops/metrics", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("devsentinel_outbox_pending");
    expect(response.body).not.toContain("repository=");
  });
  it("serves a console with CSP and no embedded credentials", async () => {
    const response = await app.inject({ method: "GET", url: "/dashboard" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["content-security-policy"]).toContain("https://avatars.githubusercontent.com");
    expect(response.body).not.toContain(token);
  });
});
