import { describe, expect, it } from "vitest";

import { redisConnectionFromUrl } from "./connection.js";

describe("redisConnectionFromUrl", () => {
  it("parses a producer connection that fails quickly", () => {
    expect(
      redisConnectionFromUrl("redis://user:secret@redis.example:6380/2", "producer"),
    ).toMatchObject({
      host: "redis.example",
      port: 6380,
      db: 2,
      username: "user",
      password: "secret",
      maxRetriesPerRequest: 1,
    });
  });

  it("configures worker connections to keep retrying", () => {
    expect(
      redisConnectionFromUrl("redis://127.0.0.1:6379", "worker"),
    ).toMatchObject({
      db: 0,
      maxRetriesPerRequest: null,
    });
  });

  it("rejects non-Redis URLs", () => {
    expect(() =>
      redisConnectionFromUrl("https://redis.example", "producer"),
    ).toThrow("REDIS_URL must use redis:// or rediss://");
  });
});
