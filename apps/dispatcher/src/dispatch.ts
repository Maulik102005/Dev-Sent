import {
  claimOutboxEvents,
  markOutboxEventPublished,
  releaseOutboxEvent,
  type Database,
} from "@devsentinel/database";
import type { OutboxJobPublisher } from "@devsentinel/queue";

export interface DispatchOutboxBatchOptions {
  db: Database;
  publisher: OutboxJobPublisher;
  ownerId: string;
  batchSize?: number;
  leaseDurationMs?: number;
  retryBaseMs?: number;
  now?: Date;
}

export interface DispatchOutboxBatchResult {
  claimed: number;
  published: number;
  failed: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryDelay(attempt: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), 60_000);
}

export async function dispatchOutboxBatch(
  options: DispatchOutboxBatchOptions,
): Promise<DispatchOutboxBatchResult> {
  const now = options.now ?? new Date();
  const events = await claimOutboxEvents(options.db, {
    ownerId: options.ownerId,
    ...(options.batchSize === undefined
      ? {}
      : { batchSize: options.batchSize }),
    ...(options.leaseDurationMs === undefined
      ? {}
      : { leaseDurationMs: options.leaseDurationMs }),
    now,
  });
  let published = 0;
  let failed = 0;

  for (const event of events) {
    try {
      await options.publisher.publish({
        outboxEventId: event.id,
        eventType: event.eventType,
        payload: event.payload,
      });

      const marked = await markOutboxEventPublished(options.db, {
        eventId: event.id,
        ownerId: options.ownerId,
        publishedAt: now,
      });

      if (!marked) {
        throw new Error(`Outbox lease lost for event ${event.id}`);
      }

      published += 1;
    } catch (error) {
      failed += 1;
      const baseMs = options.retryBaseMs ?? 1_000;
      await releaseOutboxEvent(options.db, {
        eventId: event.id,
        ownerId: options.ownerId,
        error: errorMessage(error),
        retryAt: new Date(now.getTime() + retryDelay(event.attempts, baseMs)),
      });
    }
  }

  return { claimed: events.length, published, failed };
}
