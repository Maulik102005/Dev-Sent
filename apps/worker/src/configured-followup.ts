import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerEnvironment } from "./env.js";
import { DryRunPublisher, GitHubResultPublisher, type ResultPublisher } from "./github-delivery.js";
import { OctokitInstallationTokenProvider } from "./github-app-authorizer.js";
import { defaultFollowupPolicy } from "./process-followup.js";
import { OpenAIRepairModel } from "./repair-model.js";
import { emptyIssueContextProvider, GitHubIssueContextProvider } from "./issue-context.js";

export async function createConfiguredFollowup(env: WorkerEnvironment) {
  const model = env.AGENT_MODEL_PROVIDER === "openai" ? new OpenAIRepairModel({ apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_MODEL!, maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS, maxModelTurns: env.AGENT_MAX_MODEL_TURNS }) : null;
  let publisher: ResultPublisher = new DryRunPublisher();
  let issueContext = emptyIssueContextProvider;
  if (env.AUTHORIZATION_MODE === "github-app") {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const privateKey = await readFile(resolve(root, env.GITHUB_APP_PRIVATE_KEY_PATH), "utf8");
    const tokens = new OctokitInstallationTokenProvider({ appId: env.GITHUB_APP_ID, privateKey });
    issueContext = new GitHubIssueContextProvider(tokens, { baseUrl: env.GITHUB_API_URL, apiVersion: env.GITHUB_API_VERSION });
    if (env.GITHUB_DELIVERY_MODE === "github-app") publisher = new GitHubResultPublisher(tokens, { appId: Number(env.GITHUB_APP_ID), baseUrl: env.GITHUB_API_URL, apiVersion: env.GITHUB_API_VERSION });
  }
  return { model, publisher, issueContext, policy: { ...defaultFollowupPolicy,
    allowedRepositories: env.AGENT_ALLOWED_REPOSITORIES.split(",").map((value) => value.trim()).filter(Boolean),
    maxAttempts: env.AGENT_MAX_ATTEMPTS, maxTokens: env.AGENT_MAX_TOKENS, maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
    maxDurationMs: env.AGENT_MAX_DURATION_MS, modelTimeoutMs: env.AGENT_MODEL_TIMEOUT_MS,
    maxModelTurns: env.AGENT_MAX_MODEL_TURNS, maxToolCalls: env.AGENT_MAX_TOOL_CALLS,
    maxToolOutputBytes: env.AGENT_MAX_TOOL_OUTPUT_KB * 1024,
    clarificationTtlMs: env.AGENT_CLARIFICATION_TTL_MS,
    allowRegressionTests: env.AGENT_ALLOW_REGRESSION_TESTS,
    inputCostMicrousdPerMillion: env.AGENT_INPUT_COST_MICROUSD_PER_MILLION ?? null,
    outputCostMicrousdPerMillion: env.AGENT_OUTPUT_COST_MICROUSD_PER_MILLION ?? null,
  } };
}
