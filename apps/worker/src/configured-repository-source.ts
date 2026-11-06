import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkerEnvironment } from "./env.js";
import { OctokitInstallationTokenProvider } from "./github-app-authorizer.js";
import {
  GitHubApiSnapshotClient,
  GitHubRepositorySource,
} from "./github-repository-source.js";
import {
  LocalDirectoryRepositorySource,
  type RepositorySource,
} from "./repository-source.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

function fromWorkspace(path: string): string {
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

export async function createConfiguredRepositorySource(
  environment: WorkerEnvironment,
): Promise<RepositorySource> {
  if (environment.REPOSITORY_SOURCE_MODE === "local") {
    return new LocalDirectoryRepositorySource(
      fromWorkspace(environment.LOCAL_REPOSITORY_PATH),
    );
  }

  if (environment.AUTHORIZATION_MODE !== "github-app") {
    throw new Error(
      "github-app repository source requires github-app authorization",
    );
  }

  const privateKey = await readFile(
    fromWorkspace(environment.GITHUB_APP_PRIVATE_KEY_PATH),
    "utf8",
  );
  createPrivateKey(privateKey);

  return new GitHubRepositorySource(
    new OctokitInstallationTokenProvider({
      appId: environment.GITHUB_APP_ID,
      privateKey,
    }),
    new GitHubApiSnapshotClient({
      baseUrl: environment.GITHUB_API_URL,
      apiVersion: environment.GITHUB_API_VERSION,
    }),
  );
}
