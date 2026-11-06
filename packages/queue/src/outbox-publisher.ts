import type { Queue } from "bullmq";

import {
  authorizationJobName,
  authorizationOutboxPayloadSchema,
} from "./authorization.js";
import { baselineJobName, baselineOutboxPayloadSchema } from "./baseline.js";

export interface PublishableOutboxEvent {
  outboxEventId: string;
  eventType: string;
  payload: unknown;
}

export interface OutboxJobPublisher {
  publish(event: PublishableOutboxEvent): Promise<void>;
  close(): Promise<void>;
}

export class BullMqOutboxJobPublisher implements OutboxJobPublisher {
  constructor(
    private readonly authorizationQueue: Queue,
    private readonly baselineQueue: Queue,
    private readonly followupQueue?: Queue,
  ) {}

  async publish(event: PublishableOutboxEvent): Promise<void> {
    const commonOptions = {
      jobId: `outbox-${event.outboxEventId}`,
      backoff: { type: "exponential" as const, delay: 1_000 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 604_800, count: 50_000 },
    };

    if (event.eventType === "run.authorization.requested") {
      const payload = authorizationOutboxPayloadSchema.parse(event.payload);
      await this.authorizationQueue.add(
        authorizationJobName,
        { outboxEventId: event.outboxEventId, ...payload },
        { ...commonOptions, attempts: 5 },
      );
      return;
    }

    if (event.eventType === "run.baseline.requested") {
      const payload = baselineOutboxPayloadSchema.parse(event.payload);
      await this.baselineQueue.add(
        baselineJobName,
        { outboxEventId: event.outboxEventId, ...payload },
        { ...commonOptions, attempts: 3 },
      );
      return;
    }

    if (event.eventType === "run.followup.requested" && this.followupQueue) {
      const payload = baselineOutboxPayloadSchema.parse(event.payload);
      await this.followupQueue.add("followup-run", { outboxEventId: event.outboxEventId, ...payload }, { ...commonOptions, attempts: 5, backoff: { type: "exponential", delay: 30000 } });
      return;
    }
    throw new Error(`Unsupported outbox event: ${event.eventType}`);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.authorizationQueue.close(),
      this.baselineQueue.close(),
      this.followupQueue?.close(),
    ]);
  }
}
