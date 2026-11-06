import { describe, expect, it } from "vitest";

import {
  permissionMeetsMinimum,
  type AuthorizationTarget,
} from "./authorization.js";
import {
  GitHubApiError,
  GitHubAppAuthorizer,
  GitHubRepositoryPermissionClient,
  type InstallationTokenProvider,
  type InstallationTokenRequest,
  type RepositoryPermission,
  type RepositoryPermissionClient,
  type RepositoryPermissionRequest,
} from "./github-app-authorizer.js";

const target: AuthorizationTarget = {
  runId: "9d889218-f937-4d36-82b5-0436bc51ee89",
  mode: "FIX",
  githubInstallationId: 901,
  githubRepositoryId: 501,
  repositoryFullName: "octocat/hello-world",
  issueNumber: 42,
  actorLogin: "maintainer",
};

class RecordingTokenProvider implements InstallationTokenProvider {
  readonly requests: InstallationTokenRequest[] = [];

  async getToken(request: InstallationTokenRequest): Promise<string> {
    this.requests.push(request);
    return request.refresh ? "refreshed-token" : "initial-token";
  }
}

class StubPermissionClient implements RepositoryPermissionClient {
  readonly requests: RepositoryPermissionRequest[] = [];

  constructor(
    private readonly respond: (
      request: RepositoryPermissionRequest,
      attempt: number,
    ) => Promise<RepositoryPermission>,
  ) {}

  async getPermission(
    request: RepositoryPermissionRequest,
  ): Promise<RepositoryPermission> {
    this.requests.push(request);
    return this.respond(request, this.requests.length);
  }
}

describe("permissionMeetsMinimum", () => {
  it.each([
    ["none", "write", false],
    ["read", "write", false],
    ["write", "write", true],
    ["admin", "write", true],
    ["write", "admin", false],
  ] as const)("compares %s against %s", (actual, required, expected) => {
    expect(permissionMeetsMinimum(actual, required)).toBe(expected);
  });
});

describe("GitHubAppAuthorizer", () => {
  it("allows a writer and scopes authentication to one repository", async () => {
    const tokens = new RecordingTokenProvider();
    const permissions = new StubPermissionClient(async () => ({
      permission: "write",
      roleName: "maintain",
    }));
    const authorizer = new GitHubAppAuthorizer(tokens, permissions, {
      TEST: "write",
      FIX: "write",
    });

    await expect(authorizer.authorize(target)).resolves.toEqual({
      allowed: true,
      reason:
        "GitHub permission write (role: maintain) meets required write permission for FIX",
    });
    expect(tokens.requests).toEqual([
      { installationId: 901, repositoryId: 501 },
    ]);
    expect(permissions.requests).toEqual([
      {
        token: "initial-token",
        owner: "octocat",
        repository: "hello-world",
        username: "maintainer",
      },
    ]);
  });

  it("denies read permission when write is required", async () => {
    const authorizer = new GitHubAppAuthorizer(
      new RecordingTokenProvider(),
      new StubPermissionClient(async () => ({
        permission: "read",
        roleName: "triage",
      })),
      { TEST: "write", FIX: "write" },
    );

    await expect(authorizer.authorize({ ...target, mode: "TEST" })).resolves.toEqual({
      allowed: false,
      reason:
        "GitHub permission read (role: triage) does not meet required write permission for TEST",
    });
  });

  it("refreshes an installation token once after HTTP 401", async () => {
    const tokens = new RecordingTokenProvider();
    const permissions = new StubPermissionClient(async (_request, attempt) => {
      if (attempt === 1) {
        throw new GitHubApiError("expired token", 401, "request-one");
      }

      return { permission: "admin", roleName: "admin" };
    });
    const authorizer = new GitHubAppAuthorizer(tokens, permissions, {
      TEST: "write",
      FIX: "write",
    });

    await expect(authorizer.authorize(target)).resolves.toMatchObject({
      allowed: true,
    });
    expect(tokens.requests).toEqual([
      { installationId: 901, repositoryId: 501 },
      { installationId: 901, repositoryId: 501, refresh: true },
    ]);
    expect(permissions.requests.map((request) => request.token)).toEqual([
      "initial-token",
      "refreshed-token",
    ]);
  });

  it("does not turn a GitHub server error into a permission denial", async () => {
    const authorizer = new GitHubAppAuthorizer(
      new RecordingTokenProvider(),
      new StubPermissionClient(async () => {
        throw new GitHubApiError("unavailable", 503, "request-two");
      }),
      { TEST: "write", FIX: "write" },
    );

    await expect(authorizer.authorize(target)).rejects.toMatchObject({
      status: 503,
      requestId: "request-two",
    });
  });

  it("rejects malformed repository names before requesting a token", async () => {
    const tokens = new RecordingTokenProvider();
    const authorizer = new GitHubAppAuthorizer(
      tokens,
      new StubPermissionClient(async () => ({
        permission: "admin",
        roleName: "admin",
      })),
      { TEST: "write", FIX: "write" },
    );

    await expect(
      authorizer.authorize({ ...target, repositoryFullName: "not-a-full-name" }),
    ).rejects.toThrow("Invalid GitHub repository full name");
    expect(tokens.requests).toHaveLength(0);
  });
});

describe("GitHubRepositoryPermissionClient", () => {
  it("uses the versioned permission endpoint without exposing the token", async () => {
    let requestedUrl = "";
    let requestedHeaders = new Headers();
    const fetchImplementation: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({ permission: "write", role_name: "maintain" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = new GitHubRepositoryPermissionClient({
      baseUrl: "https://github.example/api/v3",
      apiVersion: "2026-03-10",
      fetchImplementation,
    });

    await expect(
      client.getPermission({
        token: "secret-installation-token",
        owner: "octo cat",
        repository: "hello-world",
        username: "maintainer+bot",
      }),
    ).resolves.toEqual({ permission: "write", roleName: "maintain" });

    expect(requestedUrl).toBe(
      "https://github.example/api/v3/repos/octo%20cat/hello-world/collaborators/maintainer%2Bbot/permission",
    );
    expect(requestedHeaders.get("authorization")).toBe(
      "Bearer secret-installation-token",
    );
    expect(requestedHeaders.get("x-github-api-version")).toBe("2026-03-10");
  });

  it("maps GitHub 404 to no permission", async () => {
    const client = new GitHubRepositoryPermissionClient({
      baseUrl: "https://api.github.com",
      apiVersion: "2026-03-10",
      fetchImplementation: async () => new Response(null, { status: 404 }),
    });

    await expect(
      client.getPermission({
        token: "secret",
        owner: "octocat",
        repository: "private-repo",
        username: "outsider",
      }),
    ).resolves.toEqual({ permission: "none", roleName: null });
  });

  it("returns a sanitized error with the GitHub request ID", async () => {
    const client = new GitHubRepositoryPermissionClient({
      baseUrl: "https://api.github.com",
      apiVersion: "2026-03-10",
      fetchImplementation: async () =>
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-github-request-id": "ABC1:DEF2",
          },
        }),
    });

    const request = client.getPermission({
      token: "must-not-appear-in-errors",
      owner: "octocat",
      repository: "hello-world",
      username: "maintainer",
    });

    await expect(request).rejects.toMatchObject({
      status: 403,
      requestId: "ABC1:DEF2",
    });
    await expect(request).rejects.not.toThrow("must-not-appear-in-errors");
  });
});
