import { createDatabase } from "@devsentinel/database";
import { DockerSandboxExecutor } from "@devsentinel/sandbox";

import { createBaselineWorker } from "./baseline-worker.js";
import { createFollowupWorker } from "./followup-worker.js";
import { createConfiguredFollowup } from "./configured-followup.js";
import { createConfiguredAuthorizer } from "./configured-authorizer.js";
import { createConfiguredRepositorySource } from "./configured-repository-source.js";
import { parseWorkerEnvironment } from "./env.js";
import { GitHubApiError } from "./github-app-authorizer.js";
import {
  createAuthorizationWorker,
  sanitizedAuthorizationError,
} from "./worker.js";

const environment = parseWorkerEnvironment();
const authorizer = await createConfiguredAuthorizer(environment);
const repositorySource = await createConfiguredRepositorySource(environment);
const database = createDatabase(environment.DATABASE_URL);
const authorizationWorker = createAuthorizationWorker({
  db: database.db,
  redisUrl: environment.REDIS_URL,
  authorizer,
  concurrency: environment.WORKER_CONCURRENCY,
});
const baselineWorker = createBaselineWorker({
  db: database.db,
  redisUrl: environment.REDIS_URL,
  repositorySource,
  sandbox: new DockerSandboxExecutor({
    image: environment.SANDBOX_DOCKER_IMAGE,
    cpuLimit: environment.SANDBOX_CPU_LIMIT,
    memoryMb: environment.SANDBOX_MEMORY_MB,
    pidsLimit: environment.SANDBOX_PIDS_LIMIT,
    installTimeoutMs: environment.SANDBOX_INSTALL_TIMEOUT_MS,
    testTimeoutMs: environment.SANDBOX_TEST_TIMEOUT_MS,
    outputLimitBytes: environment.SANDBOX_OUTPUT_LIMIT_KB * 1_024,
  }),
  concurrency: environment.BASELINE_WORKER_CONCURRENCY,
});
let shuttingDown = false;
const followupWorker = createFollowupWorker({
  authorizer,
  db: database.db, redisUrl: environment.REDIS_URL, repositorySource,
  sandbox: new DockerSandboxExecutor({ image: environment.SANDBOX_DOCKER_IMAGE,
    cpuLimit: environment.SANDBOX_CPU_LIMIT, memoryMb: environment.SANDBOX_MEMORY_MB,
    pidsLimit: environment.SANDBOX_PIDS_LIMIT, installTimeoutMs: environment.SANDBOX_INSTALL_TIMEOUT_MS,
    testTimeoutMs: environment.SANDBOX_TEST_TIMEOUT_MS, outputLimitBytes: environment.SANDBOX_OUTPUT_LIMIT_KB * 1024 }),
  ...await createConfiguredFollowup(environment),
});
followupWorker.on("completed", (job, result) => console.info("Follow-up completed", { runId: job.data.runId, result }));
followupWorker.on("failed", (job, error) => console.error("Follow-up failed", { runId: job?.data.runId, error: sanitizedAuthorizationError(error) }));
followupWorker.on("error", (error) => console.error("Follow-up worker error", { error: sanitizedAuthorizationError(error) }));

if (environment.AUTHORIZATION_MODE === "development-allow-all") {
  console.warn(
    "Authorization worker is using development-allow-all; do not use this mode in production",
  );
} else {
  console.info("Authorization worker is using GitHub App permissions", {
    testMinimumPermission: environment.GITHUB_TEST_MINIMUM_PERMISSION,
    fixMinimumPermission: environment.GITHUB_FIX_MINIMUM_PERMISSION,
  });
}

authorizationWorker.on("completed", (job, result) => {
  console.info("Authorization job completed", { jobId: job.id, result });
});

authorizationWorker.on("failed", (job, error) => {
  console.error("Authorization job failed", {
    jobId: job?.id,
    error: sanitizedAuthorizationError(error),
    ...(error instanceof GitHubApiError
      ? { githubStatus: error.status, githubRequestId: error.requestId }
      : {}),
  });
});

authorizationWorker.on("error", (error) => {
  console.error("Authorization worker error", { error });
});

console.info("Baseline worker started", {
  repositorySourceMode: environment.REPOSITORY_SOURCE_MODE,
  image: environment.SANDBOX_DOCKER_IMAGE,
  cpuLimit: environment.SANDBOX_CPU_LIMIT,
  memoryMb: environment.SANDBOX_MEMORY_MB,
  pidsLimit: environment.SANDBOX_PIDS_LIMIT,
  concurrency: environment.BASELINE_WORKER_CONCURRENCY,
});

baselineWorker.on("completed", (job, result) => {
  console.info("Baseline job completed", { jobId: job.id, result });
});

baselineWorker.on("failed", (job, error) => {
  console.error("Baseline job failed", {
    jobId: job?.id,
    error: sanitizedAuthorizationError(error),
    ...(error instanceof GitHubApiError
      ? { githubStatus: error.status, githubRequestId: error.requestId }
      : {}),
  });
});

baselineWorker.on("error", (error) => {
  console.error("Baseline worker error", {
    error: sanitizedAuthorizationError(error),
  });
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.info("Authorization worker stopping", { signal });
  await Promise.all([authorizationWorker.close(), baselineWorker.close(), followupWorker.close()]);
  await database.close();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
