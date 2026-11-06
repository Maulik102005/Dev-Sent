import { runModeValues } from "@devsentinel/domain";
import { Queue } from "bullmq";
import { z } from "zod";

import { redisConnectionFromUrl } from "./connection.js";

export const baselineQueueName = "devsentinel-run-baseline";
export const baselineJobName = "baseline-run";

export const baselineOutboxPayloadSchema = z.object({
  runId: z.string().uuid(),
  mode: z.enum(runModeValues),
});

export const baselineJobDataSchema = baselineOutboxPayloadSchema.extend({
  outboxEventId: z.string().uuid(),
});

export type BaselineJobData = z.infer<typeof baselineJobDataSchema>;

export function createBaselineQueue(
  redisUrl: string,
  queueName = baselineQueueName,
): Queue {
  return new Queue(queueName, {
    connection: redisConnectionFromUrl(redisUrl, "producer"),
  });
}
