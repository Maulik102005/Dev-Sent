import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { createDatabase } from "@devsentinel/database";
import {
  BullMqOutboxJobPublisher,
  createAuthorizationQueue,
  createBaselineQueue,
  createFollowupQueue,
} from "@devsentinel/queue";

import { dispatchOutboxBatch } from "./dispatch.js";
import { parseDispatcherEnvironment } from "./env.js";

const environment = parseDispatcherEnvironment();
const database = createDatabase(environment.DATABASE_URL);
const publisher = new BullMqOutboxJobPublisher(
  createAuthorizationQueue(environment.REDIS_URL),
  createBaselineQueue(environment.REDIS_URL),
  createFollowupQueue(environment.REDIS_URL),
);
const ownerId = `${hostname()}-${process.pid}-${randomUUID()}`;
const abortController = new AbortController();

function stop(signal: string): void {
  console.info("Outbox dispatcher stopping", { signal, ownerId });
  abortController.abort();
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

console.info("Outbox dispatcher started", { ownerId });

while (!abortController.signal.aborted) {
  const result = await dispatchOutboxBatch({
    db: database.db,
    publisher,
    ownerId,
    batchSize: environment.OUTBOX_BATCH_SIZE,
    leaseDurationMs: environment.OUTBOX_LEASE_MS,
  });

  if (result.failed > 0) {
    console.error("Outbox dispatch failures", result);
  }

  if (result.claimed === 0) {
    await wait(environment.OUTBOX_POLL_INTERVAL_MS, abortController.signal);
  }
}

await publisher.close();
await database.close();
