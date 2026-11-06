import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfiguredAuthorizer } from "./configured-authorizer.js";
import { parseWorkerEnvironment } from "./env.js";
import { GitHubAppAuthorizer } from "./github-app-authorizer.js";

const temporaryDirectories: string[] = [];
const common = {
  DATABASE_URL: "postgres://devsentinel:devsentinel@127.0.0.1:54329/devsentinel",
  REDIS_URL: "redis://127.0.0.1:63799",
  AUTHORIZATION_MODE: "github-app",
  GITHUB_APP_ID: "123456",
} as const;

async function temporaryKeyFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "devsentinel-key-"));
  const path = join(directory, "app.pem");
  temporaryDirectories.push(directory);
  await writeFile(path, contents, { mode: 0o600 });
  return path;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("createConfiguredAuthorizer", () => {
  it("validates and loads a GitHub App PEM without making a network call", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const keyPath = await temporaryKeyFile(privateKey);
    const environment = parseWorkerEnvironment({
      ...common,
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    });

    await expect(createConfiguredAuthorizer(environment)).resolves.toBeInstanceOf(
      GitHubAppAuthorizer,
    );
  });

  it("fails during startup when the PEM is invalid", async () => {
    const keyPath = await temporaryKeyFile("not a private key");
    const environment = parseWorkerEnvironment({
      ...common,
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    });

    await expect(createConfiguredAuthorizer(environment)).rejects.toThrow();
  });
});
