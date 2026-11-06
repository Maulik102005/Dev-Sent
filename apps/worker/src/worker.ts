import { failRunAuthorization, type Database } from "@devsentinel/database";
import {
  authorizationJobDataSchema,
  authorizationQueueName,
  redisConnectionFromUrl,
} from "@devsentinel/queue";
import { Worker } from "bullmq";

import type { RunAuthorizer } from "./authorization.js";
import { processAuthorizationJob } from "./process-authorization.js";
import { redact } from "./repair-policy.js";

export function sanitizedWorkerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return redact(message)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/gh[psour]_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]")
    .slice(0, 1_500);
}

export const sanitizedAuthorizationError = sanitizedWorkerError;

export function createAuthorizationWorker(options: {
  db: Database;
  redisUrl: string;
  authorizer: RunAuthorizer;
  queueName?: string;
  concurrency?: number;
}): Worker {
  return new Worker(
    options.queueName ?? authorizationQueueName,
    async (job) => {
      const data = authorizationJobDataSchema.parse(job.data);

      try {
        return await processAuthorizationJob(
          options.db,
          options.authorizer,
          data,
        );
      } catch (error) {
        const maximumAttempts = job.opts.attempts ?? 1;
        const attemptBeingProcessed = job.attemptsMade + 1;

        if (attemptBeingProcessed >= maximumAttempts) {
          await failRunAuthorization(options.db, {
            runId: data.runId,
            reason: `Authorization failed after ${attemptBeingProcessed} attempt(s): ${sanitizedAuthorizationError(error)}`,
          });
        }

        throw error;
      }
    },
    {
      connection: redisConnectionFromUrl(options.redisUrl, "worker"),
      concurrency: options.concurrency ?? 5,
    },
  );
}
