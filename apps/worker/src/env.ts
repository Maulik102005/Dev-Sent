import { z } from "zod";

const commonEnvironmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  BASELINE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),
  AGENT_MODEL_PROVIDER: z.enum(["disabled", "openai"]).default("disabled"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  GITHUB_DELIVERY_MODE: z.enum(["dry-run", "github-app"]).default("dry-run"),
  AGENT_ALLOWED_REPOSITORIES: z.string().default(""),
  AGENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  AGENT_MAX_TOKENS: z.coerce.number().int().min(1000).max(1000000).default(200000),
  AGENT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(512).max(16000).default(4096),
  AGENT_MAX_MODEL_TURNS: z.coerce.number().int().min(1).max(16).default(4),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(100).default(24),
  AGENT_MAX_TOOL_OUTPUT_KB: z.coerce.number().int().min(1).max(2048).default(16),
  AGENT_INPUT_COST_MICROUSD_PER_MILLION: z.coerce.number().int().min(0).max(1_000_000_000_000).optional(),
  AGENT_OUTPUT_COST_MICROUSD_PER_MILLION: z.coerce.number().int().min(0).max(1_000_000_000_000).optional(),
  AGENT_CLARIFICATION_TTL_MS: z.coerce.number().int().min(60000).max(604800000).default(172800000),
  AGENT_ALLOW_REGRESSION_TESTS: z.enum(["true", "false"]).transform((value) => value === "true").default(false),
  AGENT_MAX_DURATION_MS: z.coerce.number().int().min(1000).max(3600000).default(900000),
  AGENT_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(120000),
  REPOSITORY_SOURCE_MODE: z
    .enum(["local", "github-app"])
    .default("local"),
  LOCAL_REPOSITORY_PATH: z
    .string()
    .min(1)
    .default("fixtures/sandbox/passing-node"),
  SANDBOX_DOCKER_IMAGE: z
    .string()
    .min(1)
    .default("node:22.23.2-bookworm-slim"),
  SANDBOX_CPU_LIMIT: z.coerce.number().positive().max(16).default(1),
  SANDBOX_MEMORY_MB: z.coerce.number().int().min(128).max(32_768).default(1_024),
  SANDBOX_PIDS_LIMIT: z.coerce.number().int().min(16).max(4_096).default(256),
  SANDBOX_INSTALL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(300_000),
  SANDBOX_TEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(300_000),
  SANDBOX_OUTPUT_LIMIT_KB: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_240)
    .default(256),
});

const developmentEnvironmentSchema = commonEnvironmentSchema.extend({
  AUTHORIZATION_MODE: z.literal("development-allow-all"),
});

const minimumPermissionSchema = z.enum(["read", "write", "admin"]);
const httpsUrlSchema = z.url().refine(
  (value) => new URL(value).protocol === "https:",
  "GitHub API URL must use HTTPS",
);

const githubAppEnvironmentSchema = commonEnvironmentSchema.extend({
  AUTHORIZATION_MODE: z.literal("github-app"),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1),
  GITHUB_API_URL: httpsUrlSchema.default("https://api.github.com"),
  GITHUB_API_VERSION: z.string().min(1).default("2026-03-10"),
  GITHUB_TEST_MINIMUM_PERMISSION: minimumPermissionSchema.default("write"),
  GITHUB_FIX_MINIMUM_PERMISSION: minimumPermissionSchema.default("write"),
});

const envSchema = z
  .discriminatedUnion("AUTHORIZATION_MODE", [
    developmentEnvironmentSchema,
    githubAppEnvironmentSchema,
  ])
  .superRefine((value, context) => {
    if (value.AGENT_MODEL_PROVIDER === "openai" && (!value.OPENAI_API_KEY?.trim() || !value.OPENAI_MODEL?.trim())) context.addIssue({ code: "custom", message: "OpenAI repair requires OPENAI_API_KEY and OPENAI_MODEL" });
    if (value.GITHUB_DELIVERY_MODE === "github-app" && (value.AUTHORIZATION_MODE !== "github-app" || value.REPOSITORY_SOURCE_MODE !== "github-app")) context.addIssue({ code: "custom", message: "GitHub delivery requires GitHub App authorization and repository source" });
    if (
      value.REPOSITORY_SOURCE_MODE === "github-app" &&
      value.AUTHORIZATION_MODE !== "github-app"
    ) {
      context.addIssue({
        code: "custom",
        path: ["REPOSITORY_SOURCE_MODE"],
        message: "github-app repository source requires github-app authorization",
      });
    }
  });

export type WorkerEnvironment = z.infer<typeof envSchema>;
export type GitHubAppWorkerEnvironment = z.infer<
  typeof githubAppEnvironmentSchema
>;

export function parseWorkerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerEnvironment {
  return envSchema.parse(environment);
}
