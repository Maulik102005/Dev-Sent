import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DevelopmentAllowAllAuthorizer,
  type RunAuthorizer,
} from "./authorization.js";
import type { WorkerEnvironment } from "./env.js";
import {
  GitHubAppAuthorizer,
  GitHubRepositoryPermissionClient,
  OctokitInstallationTokenProvider,
} from "./github-app-authorizer.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

export async function createConfiguredAuthorizer(
  environment: WorkerEnvironment,
): Promise<RunAuthorizer> {
  if (environment.AUTHORIZATION_MODE === "development-allow-all") {
    return new DevelopmentAllowAllAuthorizer();
  }

  const privateKeyPath = isAbsolute(environment.GITHUB_APP_PRIVATE_KEY_PATH)
    ? environment.GITHUB_APP_PRIVATE_KEY_PATH
    : resolve(workspaceRoot, environment.GITHUB_APP_PRIVATE_KEY_PATH);
  const privateKey = await readFile(privateKeyPath, "utf8");

  createPrivateKey(privateKey);

  return new GitHubAppAuthorizer(
    new OctokitInstallationTokenProvider({
      appId: environment.GITHUB_APP_ID,
      privateKey,
    }),
    new GitHubRepositoryPermissionClient({
      baseUrl: environment.GITHUB_API_URL,
      apiVersion: environment.GITHUB_API_VERSION,
    }),
    {
      TEST: environment.GITHUB_TEST_MINIMUM_PERMISSION,
      FIX: environment.GITHUB_FIX_MINIMUM_PERMISSION,
    },
  );
}
