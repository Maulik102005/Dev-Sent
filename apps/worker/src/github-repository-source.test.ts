import { access } from "node:fs/promises";

import type {
  ProcessRunRequest,
  ProcessRunResult,
  ProcessRunner,
} from "@devsentinel/sandbox";
import { describe, expect, it } from "vitest";

import {
  GitHubApiSnapshotClient,
  GitHubRepositorySource,
  type GitHubSnapshotClient,
} from "./github-repository-source.js";
import type {
  InstallationTokenProvider,
  InstallationTokenRequest,
} from "./github-app-authorizer.js";

class RecordingTokenProvider implements InstallationTokenProvider {
  readonly requests: InstallationTokenRequest[] = [];

  async getToken(request: InstallationTokenRequest): Promise<string> {
    this.requests.push(request);
    return "repository-token";
  }
}

class SuccessfulProcessRunner implements ProcessRunner {
  readonly requests: ProcessRunRequest[] = [];

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.requests.push(request);
    return {
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      stdout: "",
      stderr: "",
      outputTruncated: false,
    };
  }
}

describe("GitHubApiSnapshotClient", () => {
  it("resolves a ref and downloads bytes using versioned bearer requests", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    let attempt = 0;
    const fetchImplementation: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      attempt += 1;
      return attempt === 1
        ? new Response(
            JSON.stringify({ sha: "a".repeat(40) }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };
    const client = new GitHubApiSnapshotClient({
      baseUrl: "https://api.github.com",
      apiVersion: "2026-03-10",
      fetchImplementation,
    });

    const sha = await client.resolveCommit({
      token: "secret-token",
      owner: "octocat",
      repository: "hello-world",
      ref: "feature/one",
    });
    const archive = await client.downloadArchive({
      token: "secret-token",
      owner: "octocat",
      repository: "hello-world",
      commitSha: sha,
    });

    expect(sha).toBe("a".repeat(40));
    expect([...archive]).toEqual([1, 2, 3]);
    expect(requests[0]?.url).toContain("commits/feature%2Fone");
    expect(requests[1]?.url).toContain(`/tarball/${"a".repeat(40)}`);
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer secret-token",
    );
    expect(requests[0]?.headers.get("x-github-api-version")).toBe(
      "2026-03-10",
    );
  });

  it("enforces the archive size limit while streaming", async () => {
    const client = new GitHubApiSnapshotClient({
      baseUrl: "https://api.github.com",
      apiVersion: "2026-03-10",
      maximumArchiveBytes: 2,
      fetchImplementation: async () =>
        new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    });

    await expect(
      client.downloadArchive({
        token: "secret",
        owner: "octocat",
        repository: "hello-world",
        commitSha: "a".repeat(40),
      }),
    ).rejects.toThrow("exceeds 2 bytes");
  });
});

describe("GitHubRepositorySource", () => {
  it("requests contents-read scope and keeps the token out of tar arguments", async () => {
    const tokens = new RecordingTokenProvider();
    const client: GitHubSnapshotClient = {
      async resolveCommit() {
        return "b".repeat(40);
      },
      async downloadArchive() {
        return Buffer.from("fake archive");
      },
    };
    const processes = new SuccessfulProcessRunner();
    const source = new GitHubRepositorySource(tokens, client, processes);
    const snapshot = await source.materialize({
      githubInstallationId: 901,
      githubRepositoryId: 501,
      repositoryFullName: "octocat/hello-world",
      ref: "main",
    });

    expect(snapshot.commitSha).toBe("b".repeat(40));
    expect(tokens.requests).toEqual([
      {
        installationId: 901,
        repositoryId: 501,
        permissions: { metadata: "read", contents: "read" },
      },
    ]);
    expect(processes.requests[0]?.executable).toBe("tar");
    expect(processes.requests[0]?.args.join(" ")).not.toContain(
      "repository-token",
    );

    const path = snapshot.path;
    await snapshot.cleanup();
    await expect(access(path)).rejects.toThrow();
  });
});
