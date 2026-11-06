import { describe, expect, it } from "vitest";

import { parseWorkerEnvironment } from "./env.js";

const common = {
  DATABASE_URL: "postgres://devsentinel:devsentinel@127.0.0.1:54329/devsentinel",
  REDIS_URL: "redis://127.0.0.1:63799",
};

describe("parseWorkerEnvironment", () => {
  it("keeps local allow-all mode explicit", () => {
    expect(
      parseWorkerEnvironment({
        ...common,
        AUTHORIZATION_MODE: "development-allow-all",
      }),
    ).toMatchObject({
      AUTHORIZATION_MODE: "development-allow-all",
      WORKER_CONCURRENCY: 5,
      BASELINE_WORKER_CONCURRENCY: 1,
      REPOSITORY_SOURCE_MODE: "local",
      SANDBOX_CPU_LIMIT: 1,
      SANDBOX_MEMORY_MB: 1_024,
    });
  });

  it("applies secure GitHub App permission defaults", () => {
    expect(
      parseWorkerEnvironment({
        ...common,
        AUTHORIZATION_MODE: "github-app",
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY_PATH: ".secrets/devsentinel.pem",
      }),
    ).toMatchObject({
      AUTHORIZATION_MODE: "github-app",
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_API_VERSION: "2026-03-10",
      GITHUB_TEST_MINIMUM_PERMISSION: "write",
      GITHUB_FIX_MINIMUM_PERMISSION: "write",
    });
  });

  it("parses optional configured-rate cost inputs without treating them as provider billing", () => {
    expect(
      parseWorkerEnvironment({
        ...common,
        AUTHORIZATION_MODE: "development-allow-all",
        AGENT_INPUT_COST_MICROUSD_PER_MILLION: "1000000",
        AGENT_OUTPUT_COST_MICROUSD_PER_MILLION: "4000000",
      }),
    ).toMatchObject({
      AGENT_INPUT_COST_MICROUSD_PER_MILLION: 1_000_000,
      AGENT_OUTPUT_COST_MICROUSD_PER_MILLION: 4_000_000,
    });
  });

  it("refuses GitHub App mode without a private key path", () => {
    expect(() =>
      parseWorkerEnvironment({
        ...common,
        AUTHORIZATION_MODE: "github-app",
        GITHUB_APP_ID: "123456",
      }),
    ).toThrow();
  });

  it("refuses to send installation tokens to a non-HTTPS API URL", () => {
    expect(() =>
      parseWorkerEnvironment({
        ...common,
        AUTHORIZATION_MODE: "github-app",
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY_PATH: ".secrets/devsentinel.pem",
        GITHUB_API_URL: "http://github.example/api/v3",
      }),
    ).toThrow("GitHub API URL must use HTTPS");
  });

  it("refuses a GitHub repository source without GitHub App credentials", () => {
    expect(() =>
      parseWorkerEnvironment({
        ...common,
        AUTHORIZATION_MODE: "development-allow-all",
        REPOSITORY_SOURCE_MODE: "github-app",
      }),
    ).toThrow("github-app repository source requires github-app authorization");
  });
});
