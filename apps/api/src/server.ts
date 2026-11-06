import { createDatabase } from "@devsentinel/database";

import { buildApp } from "./app.js";
import { parseEnvironment } from "./env.js";

const environment = parseEnvironment();
const database = createDatabase(environment.DATABASE_URL);
const app = buildApp({
  db: database.db,
  webhookSecret: environment.GITHUB_WEBHOOK_SECRET,
  logger: true,
  ...(environment.CONTROL_API_TOKEN ? { controlToken: environment.CONTROL_API_TOKEN } : {}),
  readiness: {
    authorizationMode: environment.AUTHORIZATION_MODE,
    repositorySourceMode: environment.REPOSITORY_SOURCE_MODE,
    agentModelEnabled: environment.AGENT_MODEL_PROVIDER === "openai",
    deliveryMode: environment.GITHUB_DELIVERY_MODE,
    allowedRepositoryCount: environment.AGENT_ALLOWED_REPOSITORIES.split(",").map((value) => value.trim()).filter(Boolean).length,
  },
  inspector: {
    provider: environment.INSPECTOR_MODEL_PROVIDER,
    ...(environment.OPENAI_API_KEY ? { apiKey: environment.OPENAI_API_KEY } : {}),
    ...(environment.INSPECTOR_MODEL ? { model: environment.INSPECTOR_MODEL } : {}),
    maxQueries: environment.INSPECTOR_MAX_QUERIES,
    maxTokens: environment.INSPECTOR_MAX_TOKENS,
    maxOutputTokens: environment.INSPECTOR_MAX_OUTPUT_TOKENS,
    timeoutMs: environment.INSPECTOR_TIMEOUT_MS,
  },
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await database.close();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await app.listen({
  host: environment.HOST,
  port: environment.PORT,
});
