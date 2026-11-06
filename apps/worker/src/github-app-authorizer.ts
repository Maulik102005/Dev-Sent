import { createAppAuth } from "@octokit/auth-app";
import { z } from "zod";

import {
  githubBasePermissionValues,
  permissionMeetsMinimum,
  type AuthorizationPermissionPolicy,
  type AuthorizationTarget,
  type GitHubBasePermission,
  type RunAuthorizer,
} from "./authorization.js";

export interface InstallationTokenRequest {
  installationId: number;
  repositoryId: number;
  permissions?: {
    metadata: "read";
    contents?: "read" | "write";
    issues?: "read" | "write";
    pull_requests?: "write";
    checks?: "write";
  };
  refresh?: boolean;
}

export interface InstallationTokenProvider {
  getToken(request: InstallationTokenRequest): Promise<string>;
  getAppToken?(): Promise<string>;
}

export interface RepositoryPermission {
  permission: GitHubBasePermission;
  roleName: string | null;
}

export interface RepositoryPermissionRequest {
  token: string;
  owner: string;
  repository: string;
  username: string;
}

export interface RepositoryPermissionClient {
  getPermission(
    request: RepositoryPermissionRequest,
  ): Promise<RepositoryPermission>;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export class OctokitInstallationTokenProvider
  implements InstallationTokenProvider
{
  private readonly authenticate: ReturnType<typeof createAppAuth>;

  constructor(options: { appId: string; privateKey: string }) {
    this.authenticate = createAppAuth(options);
  }

  async getToken(request: InstallationTokenRequest): Promise<string> {
    const authentication = await this.authenticate({
      type: "installation",
      installationId: request.installationId,
      repositoryIds: [request.repositoryId],
      permissions: request.permissions ?? { metadata: "read" },
      ...(request.refresh === undefined
        ? {}
        : { refresh: request.refresh }),
    });

    return authentication.token;
  }

  async getAppToken(): Promise<string> {
    const authentication = await this.authenticate({ type: "app" });
    return authentication.token;
  }
}

const permissionResponseSchema = z.object({
  permission: z.enum(githubBasePermissionValues),
  role_name: z.string().nullable().optional(),
});

const errorResponseSchema = z.object({
  message: z.string().optional(),
});

function githubEndpoint(baseUrl: string, path: string): URL {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ""), normalizedBase);
}

export class GitHubRepositoryPermissionClient
  implements RepositoryPermissionClient
{
  constructor(
    private readonly options: {
      baseUrl: string;
      apiVersion: string;
      timeoutMs?: number;
      fetchImplementation?: typeof fetch;
    },
  ) {}

  async getPermission(
    request: RepositoryPermissionRequest,
  ): Promise<RepositoryPermission> {
    const endpoint = githubEndpoint(
      this.options.baseUrl,
      `repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(
        request.repository,
      )}/collaborators/${encodeURIComponent(request.username)}/permission`,
    );
    const fetchImplementation = this.options.fetchImplementation ?? fetch;
    const response = await fetchImplementation(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${request.token}`,
        "User-Agent": "DevSentinel/0.1.0",
        "X-GitHub-Api-Version": this.options.apiVersion,
      },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });

    if (response.status === 404) {
      return { permission: "none", roleName: null };
    }

    if (!response.ok) {
      const requestId = response.headers.get("x-github-request-id");
      const body = errorResponseSchema.safeParse(
        await response.json().catch(() => null),
      );
      const detail = body.success && body.data.message
        ? `: ${body.data.message}`
        : "";

      throw new GitHubApiError(
        `GitHub permission request failed with HTTP ${response.status}${detail}`,
        response.status,
        requestId,
      );
    }

    const parsed = permissionResponseSchema.parse(await response.json());
    return {
      permission: parsed.permission,
      roleName: parsed.role_name ?? null,
    };
  }
}

export function splitRepositoryFullName(repositoryFullName: string): {
  owner: string;
  repository: string;
} {
  const segments = repositoryFullName.split("/");

  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new Error(
      `Invalid GitHub repository full name: ${repositoryFullName}`,
    );
  }

  return { owner: segments[0], repository: segments[1] };
}

export class GitHubAppAuthorizer implements RunAuthorizer {
  constructor(
    private readonly tokenProvider: InstallationTokenProvider,
    private readonly permissionClient: RepositoryPermissionClient,
    private readonly policy: AuthorizationPermissionPolicy,
  ) {}

  async authorize(target: AuthorizationTarget) {
    const repository = splitRepositoryFullName(target.repositoryFullName);
    const tokenRequest = {
      installationId: target.githubInstallationId,
      repositoryId: target.githubRepositoryId,
    };
    let token = await this.tokenProvider.getToken(tokenRequest);
    let permission: RepositoryPermission;

    try {
      permission = await this.permissionClient.getPermission({
        token,
        ...repository,
        username: target.actorLogin,
      });
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 401) {
        throw error;
      }

      token = await this.tokenProvider.getToken({
        ...tokenRequest,
        refresh: true,
      });
      permission = await this.permissionClient.getPermission({
        token,
        ...repository,
        username: target.actorLogin,
      });
    }

    const required = this.policy[target.mode];
    const allowed = permissionMeetsMinimum(permission.permission, required);
    const roleSuffix = permission.roleName
      ? ` (role: ${permission.roleName})`
      : "";

    return {
      allowed,
      reason: allowed
        ? `GitHub permission ${permission.permission}${roleSuffix} meets required ${required} permission for ${target.mode}`
        : `GitHub permission ${permission.permission}${roleSuffix} does not meet required ${required} permission for ${target.mode}`,
    };
  }
}
