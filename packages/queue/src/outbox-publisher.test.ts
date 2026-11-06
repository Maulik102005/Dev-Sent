import type { Queue } from "bullmq";
import { describe, expect, it } from "vitest";

import { BullMqOutboxJobPublisher } from "./outbox-publisher.js";

class RecordingQueue {
  readonly jobs: Array<{ name: string; data: unknown; options: unknown }> = [];

  async add(name: string, data: unknown, options: unknown): Promise<void> {
    this.jobs.push({ name, data, options });
  }

  async close(): Promise<void> {}
}

function asQueue(queue: RecordingQueue): Queue {
  return queue as unknown as Queue;
}

describe("BullMqOutboxJobPublisher", () => {
  it("routes follow-up events with a stable ID and bounded retry policy", async () => {
    const followup = new RecordingQueue();
    const publisher = new BullMqOutboxJobPublisher(asQueue(new RecordingQueue()), asQueue(new RecordingQueue()), asQueue(followup));
    await publisher.publish({ outboxEventId: "59b2f8f2-a153-4e9c-97ac-a05665c8a71b", eventType: "run.followup.requested", payload: { runId: "bf779288-e417-4624-84fa-2c0b298cd9d9", mode: "FIX" } });
    expect(followup.jobs[0]).toMatchObject({ name: "followup-run", options: { attempts: 5, jobId: "outbox-59b2f8f2-a153-4e9c-97ac-a05665c8a71b" } });
  });
  it("routes authorization and baseline events with stable outbox job IDs", async () => {
    const authorization = new RecordingQueue();
    const baseline = new RecordingQueue();
    const publisher = new BullMqOutboxJobPublisher(
      asQueue(authorization),
      asQueue(baseline),
    );

    await publisher.publish({
      outboxEventId: "59b2f8f2-a153-4e9c-97ac-a05665c8a71b",
      eventType: "run.authorization.requested",
      payload: {
        runId: "bf779288-e417-4624-84fa-2c0b298cd9d9",
        mode: "TEST",
      },
    });
    await publisher.publish({
      outboxEventId: "c0e1e6e3-91db-4101-9504-d7c2ba08594a",
      eventType: "run.baseline.requested",
      payload: {
        runId: "bf779288-e417-4624-84fa-2c0b298cd9d9",
        mode: "TEST",
      },
    });

    expect(authorization.jobs).toHaveLength(1);
    expect(authorization.jobs[0]).toMatchObject({
      name: "authorize-run",
      options: {
        jobId: "outbox-59b2f8f2-a153-4e9c-97ac-a05665c8a71b",
        attempts: 5,
      },
    });
    expect(baseline.jobs).toHaveLength(1);
    expect(baseline.jobs[0]).toMatchObject({
      name: "baseline-run",
      options: {
        jobId: "outbox-c0e1e6e3-91db-4101-9504-d7c2ba08594a",
        attempts: 3,
      },
    });
  });

  it("fails closed for an unknown event type", async () => {
    const publisher = new BullMqOutboxJobPublisher(
      asQueue(new RecordingQueue()),
      asQueue(new RecordingQueue()),
    );

    await expect(
      publisher.publish({
        outboxEventId: "59b2f8f2-a153-4e9c-97ac-a05665c8a71b",
        eventType: "run.unknown",
        payload: {},
      }),
    ).rejects.toThrow("Unsupported outbox event");
  });
});
