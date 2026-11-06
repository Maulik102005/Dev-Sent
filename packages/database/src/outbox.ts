import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { Database } from "./client.js";
import { outboxEvents } from "./schema.js";

export interface ClaimOutboxOptions {
  ownerId: string;
  batchSize?: number;
  leaseDurationMs?: number;
  now?: Date;
}

export interface ClaimedOutboxEvent {
  id: string;
  eventType: string;
  payload: unknown;
  attempts: number;
}

export async function claimOutboxEvents(
  db: Database,
  options: ClaimOutboxOptions,
): Promise<ClaimedOutboxEvent[]> {
  const batchSize = options.batchSize ?? 25;
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("Outbox batch size must be an integer between 1 and 100");
  }

  if (leaseDurationMs < 1_000) {
    throw new Error("Outbox lease must be at least 1000 ms");
  }

  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - leaseDurationMs);

  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        and(
          isNull(outboxEvents.publishedAt),
          isNull(outboxEvents.deadLetteredAt),
          lte(outboxEvents.availableAt, now),
          or(
            isNull(outboxEvents.lockedAt),
            lt(outboxEvents.lockedAt, staleBefore),
          ),
        ),
      )
      .orderBy(asc(outboxEvents.createdAt))
      .limit(batchSize)
      .for("update", { skipLocked: true });

    if (candidates.length === 0) {
      return [];
    }

    return tx
      .update(outboxEvents)
      .set({
        attempts: sql`${outboxEvents.attempts} + 1`,
        lockedAt: now,
        lockOwner: options.ownerId,
      })
      .where(
        inArray(
          outboxEvents.id,
          candidates.map((candidate) => candidate.id),
        ),
      )
      .returning({
        id: outboxEvents.id,
        eventType: outboxEvents.eventType,
        payload: outboxEvents.payload,
        attempts: outboxEvents.attempts,
      });
  });
}

export async function markOutboxEventPublished(
  db: Database,
  input: { eventId: string; ownerId: string; publishedAt?: Date },
): Promise<boolean> {
  const [published] = await db
    .update(outboxEvents)
    .set({
      publishedAt: input.publishedAt ?? new Date(),
      lockedAt: null,
      lockOwner: null,
      lastError: null,
    })
    .where(
      and(
        eq(outboxEvents.id, input.eventId),
        eq(outboxEvents.lockOwner, input.ownerId),
        isNull(outboxEvents.publishedAt),
      ),
    )
    .returning({ id: outboxEvents.id });

  return published !== undefined;
}

export async function releaseOutboxEvent(
  db: Database,
  input: {
    eventId: string;
    ownerId: string;
    error: string;
    retryAt: Date;
  },
): Promise<boolean> {
  const [released] = await db
    .update(outboxEvents)
    .set({
      availableAt: input.retryAt,
      lockedAt: null,
      lockOwner: null,
      lastError: input.error.slice(0, 2_000),
      deadLetteredAt: sql`case when ${outboxEvents.attempts} >= 10 then now() else null end`,
    })
    .where(
      and(
        eq(outboxEvents.id, input.eventId),
        eq(outboxEvents.lockOwner, input.ownerId),
        isNull(outboxEvents.publishedAt),
      ),
    )
    .returning({ id: outboxEvents.id });

  return released !== undefined;
}
