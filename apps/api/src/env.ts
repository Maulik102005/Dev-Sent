import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  DATABASE_URL: z.string().url(),
  GITHUB_WEBHOOK_SECRET: z.string().min(16),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  CONTROL_API_TOKEN: z.string().min(32).optional(),
  AUTHORIZATION_MODE: z.enum(["development-allow-all", "github-app"]).default("development-allow-all"),
  REPOSITORY_SOURCE_MODE: z.enum(["local", "github-app"]).default("local"),
  AGENT_MODEL_PROVIDER: z.enum(["disabled", "openai"]).default("disabled"),
  GITHUB_DELIVERY_MODE: z.enum(["dry-run", "github-app"]).default("dry-run"),
  AGENT_ALLOWED_REPOSITORIES: z.string().default(""),
  INSPECTOR_MODEL_PROVIDER: z.enum(["disabled", "openai"]).default("disabled"),
  INSPECTOR_MODEL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  INSPECTOR_MAX_QUERIES: z.coerce.number().int().min(1).max(100).default(20),
  INSPECTOR_MAX_TOKENS: z.coerce.number().int().min(1000).max(1000000).default(50000),
  INSPECTOR_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(128).max(4000).default(800),
  INSPECTOR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
}).superRefine((value, context) => {
  if (value.INSPECTOR_MODEL_PROVIDER === "openai" && (!value.OPENAI_API_KEY?.trim() || !value.INSPECTOR_MODEL?.trim())) {
    context.addIssue({ code: "custom", message: "OpenAI inspector requires OPENAI_API_KEY and INSPECTOR_MODEL" });
  }
});

export type ApiEnvironment = z.infer<typeof envSchema>;

export function parseEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ApiEnvironment {
  return envSchema.parse(environment);
}
