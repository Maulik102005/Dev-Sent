import type { ConnectionOptions } from "bullmq";

export type RedisConnectionRole = "producer" | "worker";

export function redisConnectionFromUrl(
  redisUrl: string,
  role: RedisConnectionRole,
): ConnectionOptions {
  const parsed = new URL(redisUrl);

  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }

  const databaseText = parsed.pathname.replace(/^\//, "");
  const database = databaseText === "" ? 0 : Number(databaseText);

  if (!Number.isInteger(database) || database < 0) {
    throw new Error("REDIS_URL database must be a non-negative integer");
  }

  return {
    host: parsed.hostname,
    port: parsed.port === "" ? 6379 : Number(parsed.port),
    db: database,
    maxRetriesPerRequest: role === "worker" ? null : 1,
    ...(parsed.username
      ? { username: decodeURIComponent(parsed.username) }
      : {}),
    ...(parsed.password
      ? { password: decodeURIComponent(parsed.password) }
      : {}),
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}
