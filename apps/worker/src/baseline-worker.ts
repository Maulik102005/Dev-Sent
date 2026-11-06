import { failRunBaseline, type Database } from "@devsentinel/database";
import {
  baselineJobDataSchema,
  baselineQueueName,
  redisConnectionFromUrl,
} from "@devsentinel/queue";
import type { BaselineSandbox } from "@devsentinel/sandbox";
import { Worker } from "bullmq";

import { processBaselineJob } from "./process-baseline.js";
import type { RepositorySource } from "./repository-source.js";
import { sanitizedWorkerError } from "./worker.js";

export function createBaselineWorker(options: {
  db: Database;
  redisUrl: string;
  repositorySource: RepositorySource;
  sandbox: BaselineSandbox;
  queueName?: string;
  concurrency?: number;
}): Worker {
  return new Worker(
    options.queueName ?? baselineQueueName,
    async (job) => {
      const data = baselineJobDataSchema.parse(job.data);

      try {
        return await processBaselineJob(
          options.db,
          options.repositorySource,
          options.sandbox,
          data,
        );
      } catch (error) {
        const maximumAttempts = job.opts.attempts ?? 1;
        const attemptBeingProcessed = job.attemptsMade + 1;

        if (attemptBeingProcessed >= maximumAttempts) {
          await failRunBaseline(options.db, {
            runId: data.runId,
            reason: `Baseline failed after ${attemptBeingProcessed} attempt(s): ${sanitizedWorkerError(error)}`,
          });
        }

        throw error;
      }
    },
    {
      connection: redisConnectionFromUrl(options.redisUrl, "worker"),
      concurrency: options.concurrency ?? 1,
    },
  );
}
