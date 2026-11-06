import { recordWorkflowFailure } from "@devsentinel/database";
import { followupJobDataSchema, followupQueueName, redisConnectionFromUrl } from "@devsentinel/queue";
import { Worker } from "bullmq";
import { processFollowupJob } from "./process-followup.js";
import { sanitizedWorkerError } from "./worker.js";

export function createFollowupWorker(options: Parameters<typeof processFollowupJob>[0] & { redisUrl: string; queueName?: string }) {
  return new Worker(options.queueName ?? followupQueueName, async (job) => {
    const data = followupJobDataSchema.parse(job.data);
    try { return await processFollowupJob(options, data); }
    catch (error) {
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) await recordWorkflowFailure(options.db, data.runId, sanitizedWorkerError(error));
      // Queue failure text is intentionally sanitized: SDK/request errors may contain credentials.
      throw new Error(sanitizedWorkerError(error));
    }
  }, { connection: redisConnectionFromUrl(options.redisUrl, "worker"), concurrency: 1 });
}
