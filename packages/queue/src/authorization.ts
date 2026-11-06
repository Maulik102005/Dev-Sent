import { runModeValues } from "@devsentinel/domain";
import { Queue } from "bullmq";
import { z } from "zod";

import { redisConnectionFromUrl } from "./connection.js";

export const authorizationQueueName = "devsentinel-run-authorization";
export const authorizationJobName = "authorize-run";

export const authorizationOutboxPayloadSchema = z.object({
  runId: z.string().uuid(),
  mode: z.enum(runModeValues),
});

export const authorizationJobDataSchema =
  authorizationOutboxPayloadSchema.extend({
    outboxEventId: z.string().uuid(),
  });

export type AuthorizationOutboxPayload = z.infer<
  typeof authorizationOutboxPayloadSchema
>;
export type AuthorizationJobData = z.infer<typeof authorizationJobDataSchema>;

export function createAuthorizationQueue(
  redisUrl: string,
  queueName = authorizationQueueName,
): Queue {
  return new Queue(queueName, {
    connection: redisConnectionFromUrl(redisUrl, "producer"),
  });
}
