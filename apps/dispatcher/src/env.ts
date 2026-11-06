import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  OUTBOX_LEASE_MS: z.coerce.number().int().min(1_000).default(30_000),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1_000),
});

export function parseDispatcherEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return envSchema.parse(environment);
}
