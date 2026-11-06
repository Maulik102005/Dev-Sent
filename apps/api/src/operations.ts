import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  answerClarificationAsOperator,
  approveScopeExpansion,
  cancelRun,
  getRunDetail,
  getRunEvidencePage,
  getRunEventStreamBatch,
  listRunsPage,
  requestRunRecovery,
  type Database,
} from "@devsentinel/database";
import { answerInspectorQuestion, type InspectorConfiguration } from "./inspector.js";

export interface OperationsReadiness {
  authorizationMode: "development-allow-all" | "github-app";
  repositorySourceMode: "local" | "github-app";
  agentModelEnabled: boolean;
  deliveryMode: "dry-run" | "github-app";
  allowedRepositoryCount: number;
}

const defaultReadiness: OperationsReadiness = {
  authorizationMode: "development-allow-all",
  repositorySourceMode: "local",
  agentModelEnabled: false,
  deliveryMode: "dry-run",
  allowedRepositoryCount: 0,
};

const defaultInspector: InspectorConfiguration = {
  provider: "disabled",
  maxQueries: 20,
  maxTokens: 50000,
  maxOutputTokens: 800,
  timeoutMs: 30000,
};

function parseBody(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  try { return JSON.parse(body.toString("utf8")); }
  catch { return null; }
}

function sseCursor(value: string | string[] | undefined): { createdAt: Date; id: string } | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const match = raw ? /^(\d{13})\|([0-9a-f-]{36})$/i.exec(raw) : null;
  if (!match) return null;
  const createdAt = new Date(Number(match[1]));
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id: match[2]! };
}

export async function registerOperations(
  app: FastifyInstance,
  db: Database,
  token?: string,
  readiness: OperationsReadiness = defaultReadiness,
  inspector: InspectorConfiguration = defaultInspector,
): Promise<void> {
  const validId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const digest = (value: string) => createHash("sha256").update(value).digest();
  await app.register(async (ops) => {
    ops.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("X-Content-Type-Options", "nosniff");
      if (!token || token.length < 32) return reply.code(404).send({ error: "Control API is disabled" });
      const supplied = request.headers.authorization;
      if (!supplied || !timingSafeEqual(digest(supplied), digest(`Bearer ${token}`))) return reply.code(401).send({ error: "Unauthorized" });
      if (request.method === "POST" && request.headers["sec-fetch-site"] === "cross-site") return reply.code(403).send({ error: "Cross-site mutations are blocked" });
      if (request.method === "POST" && request.headers.origin) {
        const expected = `${request.protocol}://${request.headers.host}`;
        if (request.headers.origin !== expected) return reply.code(403).send({ error: "Cross-origin mutations are blocked" });
      }
    });

    ops.get<{ Querystring: Record<string, string | undefined> }>("/runs", async (request, reply) => {
      const parsed = z.object({
        limit: z.coerce.number().int().min(1).max(100).default(30),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        status: z.string().max(40).optional(),
        mode: z.enum(["TEST", "FIX"]).optional(),
        q: z.string().max(120).optional(),
      }).safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid run filters" });
      return listRunsPage(db, {
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
        ...(parsed.data.q?.trim() ? { search: parsed.data.q.trim() } : {}),
      });
    });

    ops.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
      if (!validId(request.params.id)) return reply.code(400).send({ error: "Invalid run id" });
      const detail = await getRunDetail(db, request.params.id);
      return detail ?? reply.code(404).send({ error: "Run not found" });
    });

    ops.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>("/runs/:id/evidence", async (request, reply) => {
      if (!validId(request.params.id)) return reply.code(400).send({ error: "Invalid run id" });
      const parsed = z.object({
        kind: z.enum(["events", "context", "inspector"]),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      }).safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid evidence page" });
      return getRunEvidencePage(db, { runId: request.params.id, ...parsed.data });
    });

    for (const action of ["cancel", "retry"] as const) ops.post<{ Params: { id: string }; Body: unknown }>(`/runs/:id/${action}`, async (request, reply) => {
      if (!validId(request.params.id)) return reply.code(400).send({ error: "Invalid run id" });
      const parsed = z.object({ confirmed: z.literal(true) }).strict().safeParse(parseBody(request.body));
      if (!parsed.success) return reply.code(400).send({ error: "Explicit confirmation is required" });
      const accepted = await (action === "cancel" ? cancelRun : requestRunRecovery)(db, request.params.id);
      return accepted ? { accepted } : reply.code(409).send({ error: "Run cannot accept this action in its current state" });
    });

    ops.post<{ Params: { id: string }; Body: unknown }>("/runs/:id/clarification", async (request, reply) => {
      if (!validId(request.params.id)) return reply.code(400).send({ error: "Invalid run id" });
      const parsed = z.object({ answer: z.string().min(1).max(4000), confirmed: z.literal(true) }).strict().safeParse(parseBody(request.body));
      if (!parsed.success) return reply.code(400).send({ error: "A bounded answer and explicit confirmation are required" });
      const accepted = await answerClarificationAsOperator(db, request.params.id, parsed.data.answer);
      return accepted ? { accepted } : reply.code(409).send({ error: "No open clarification can accept this answer" });
    });

    ops.post<{ Params: { id: string }; Body: unknown }>("/runs/:id/scope", async (request, reply) => {
      if (!validId(request.params.id)) return reply.code(400).send({ error: "Invalid run id" });
      const parsed = z.object({ paths: z.array(z.string()).min(1).max(20), reason: z.string().min(1).max(2000), confirmed: z.literal(true) }).strict().safeParse(parseBody(request.body));
      if (!parsed.success) return reply.code(400).send({ error: "Bounded paths, reason, and explicit confirmation are required" });
      const accepted = await approveScopeExpansion(db, { runId: request.params.id, paths: parsed.data.paths, reason: parsed.data.reason, confirmed: true });
      return accepted ? { accepted } : reply.code(409).send({ error: "Scope expansion was rejected" });
    });

    ops.post<{ Params: { id: string }; Body: unknown }>("/runs/:id/inspect", async (request, reply) => {
      if (!validId(request.params.id)) return reply.code(400).send({ error: "Invalid run id" });
      const parsed = z.object({ question: z.string().min(1).max(2000) }).strict().safeParse(parseBody(request.body));
      if (!parsed.success) return reply.code(400).send({ error: "A bounded inspector question is required" });
      try {
        const answer = await answerInspectorQuestion(db, { runId: request.params.id, question: parsed.data.question, config: inspector });
        return answer ?? reply.code(404).send({ error: "Run not found" });
      } catch (error) {
        return reply.code(429).send({ error: error instanceof Error ? error.message : "Inspector request failed" });
      }
    });

    ops.get("/readiness", async () => {
      const [database] = await db.execute<{ ready: number }>("SELECT 1::integer AS ready");
      const [work] = await db.execute<{ pending: number; dead: number }>(`SELECT
        (SELECT count(*)::integer FROM outbox_events WHERE published_at IS NULL AND dead_lettered_at IS NULL) AS pending,
        ((SELECT count(*)::integer FROM run_workflows WHERE last_error IS NOT NULL) + (SELECT count(*)::integer FROM outbox_events WHERE dead_lettered_at IS NOT NULL)) AS dead`);
      return {
        service: "api",
        database: database?.ready === 1 ? "ready" : "unavailable",
        authorizationMode: readiness.authorizationMode,
        repositorySourceMode: readiness.repositorySourceMode,
        model: readiness.agentModelEnabled ? "configured" : "disabled",
        inspector: inspector.provider === "openai" ? "configured" : "fallback",
        deliveryMode: readiness.deliveryMode,
        allowedRepositoryCount: readiness.allowedRepositoryCount,
        pendingOutbox: work?.pending ?? 0,
        deadLetters: work?.dead ?? 0,
      };
    });

    ops.get("/events", async (request, reply) => {
      const cursor = sseCursor(request.headers["last-event-id"]);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      let current = cursor;
      const deadline = Date.now() + 25000;
      while (!request.raw.aborted && Date.now() < deadline) {
        const rows = await getRunEventStreamBatch(db, current);
        for (const row of rows) {
          const createdAt = new Date(row.createdAt);
          current = { createdAt, id: row.id };
          reply.raw.write(`id: ${createdAt.getTime()}|${row.id}\nevent: run\ndata: ${JSON.stringify({ ...row, createdAt: createdAt.toISOString() })}\n\n`);
        }
        if (rows.length === 0) reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      reply.raw.end();
    });

    ops.get("/metrics", async (_request, reply) => {
      const status = await db.execute<{ status: string; count: number }>("SELECT status, count(*)::integer AS count FROM runs GROUP BY status");
      const [work] = await db.execute<{ pending: number; dead: number; reserved: number; inspector: number }>(`SELECT
        (SELECT count(*)::integer FROM outbox_events WHERE published_at IS NULL AND dead_lettered_at IS NULL) AS pending,
        ((SELECT count(*)::integer FROM run_workflows WHERE last_error IS NOT NULL) + (SELECT count(*)::integer FROM outbox_events WHERE dead_lettered_at IS NOT NULL)) AS dead,
        (SELECT coalesce(sum(reserved_tokens), 0)::integer FROM run_workflows) AS reserved,
        (SELECT coalesce(sum(inspector_reserved_tokens), 0)::integer FROM run_workflows) AS inspector`);
      reply.type("text/plain; version=0.0.4");
      return ["# TYPE devsentinel_runs gauge", ...status.map((item) => `devsentinel_runs{status="${item.status}"} ${item.count}`),
        `devsentinel_outbox_pending ${work?.pending ?? 0}`, `devsentinel_dead_letters ${work?.dead ?? 0}`, `devsentinel_reserved_token_units ${work?.reserved ?? 0}`, `devsentinel_inspector_reserved_token_units ${work?.inspector ?? 0}`, ""].join("\n");
    });
  }, { prefix: "/ops" });

  for (const [route, file, type] of [
    ["/dashboard", "dashboard.html", "text/html"],
    ["/dashboard.js", "dashboard.js", "text/javascript"],
    ["/dashboard.css", "dashboard.css", "text/css"],
  ]) {
    app.get(route!, async (_request, reply) => {
      reply.header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      reply.header("Referrer-Policy", "no-referrer");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Cache-Control", "no-store");
      return reply.type(type!).send(await readFile(new URL(`./${file}`, import.meta.url), "utf8"));
    });
  }
}
