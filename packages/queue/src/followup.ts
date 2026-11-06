import { Queue } from "bullmq";
import { redisConnectionFromUrl } from "./connection.js";
export { baselineJobDataSchema as followupJobDataSchema } from "./baseline.js";
export const followupQueueName = "devsentinel-run-followup";
export function createFollowupQueue(redisUrl: string, queueName = followupQueueName): Queue {
  return new Queue(queueName, { connection: redisConnectionFromUrl(redisUrl, "producer") });
}
