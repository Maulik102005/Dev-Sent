import { extractRunContinuation, extractRunTrigger } from "@devsentinel/domain";
import {
  ingestWebhook,
  ingestRunContinuation,
  type Database,
} from "@devsentinel/database";
import Fastify, { type FastifyInstance } from "fastify";

import { verifyGitHubSignature } from "./github-signature.js";
import { registerOperations } from "./operations.js";
import type { InspectorConfiguration } from "./inspector.js";
import type { OperationsReadiness } from "./operations.js";

export interface BuildAppOptions {
  db: Database;
  webhookSecret: string;
  logger?: boolean;
  controlToken?: string;
  readiness?: OperationsReadiness;
  inspector?: InspectorConfiguration;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    bodyLimit: 1_048_576,
    logger: options.logger ?? false,
  });

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.get("/health", async () => ({ status: "ok" }));
  app.register(async (instance) => registerOperations(instance, options.db, options.controlToken, options.readiness, options.inspector));

  app.post("/webhooks/github", async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) {
      return reply.code(400).send({ error: "Expected a JSON request body" });
    }

    const signature = headerValue(request.headers["x-hub-signature-256"]);

    if (
      !verifyGitHubSignature(
        request.body,
        signature,
        options.webhookSecret,
      )
    ) {
      return reply.code(401).send({ error: "Invalid webhook signature" });
    }

    const deliveryId = headerValue(request.headers["x-github-delivery"]);
    const eventName = headerValue(request.headers["x-github-event"]);

    if (!deliveryId || !eventName) {
      return reply.code(400).send({
        error: "Missing x-github-delivery or x-github-event header",
      });
    }

    let payload: unknown;

    try {
      payload = JSON.parse(request.body.toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "Malformed JSON payload" });
    }

    const action =
      typeof payload === "object" &&
      payload !== null &&
      "action" in payload &&
      typeof payload.action === "string"
        ? payload.action
        : null;
    const trigger = extractRunTrigger(eventName, payload);
    const continuation = extractRunContinuation(eventName, payload);
    if (continuation) {
      const continued = await ingestRunContinuation(options.db, {
        deliveryId,
        eventName,
        action,
        payload,
        continuation,
      });
      if (continued.kind === "duplicate") return reply.code(200).send({ duplicate: true });
      if (continued.kind === "ignored") return reply.code(200).send({ ignored: true, reason: continued.reason });
      return reply.code(202).send({ accepted: true, runId: continued.runId, continuation: true, status: "DIAGNOSING" });
    }
    const result = await ingestWebhook(options.db, {
      deliveryId,
      eventName,
      action,
      payload,
      trigger,
    });

    if (result.kind === "duplicate") {
      return reply.code(200).send({ duplicate: true });
    }

    if (result.kind === "ignored") {
      return reply.code(200).send({ ignored: true });
    }

    return reply.code(202).send({
      accepted: true,
      runId: result.runId,
      mode: trigger?.mode,
      status: "AUTHORIZING",
    });
  });

  return app;
}
