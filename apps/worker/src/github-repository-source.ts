import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SpawnProcessRunner, type ProcessRunner } from "@devsentinel/sandbox";
import { z } from "zod";

import {
  GitHubApiError,
  splitRepositoryFullName,
  type InstallationTokenProvider,
} from "./github-app-authorizer.js";
import type {
  RepositorySnapshot,
  RepositorySnapshotTarget,
  RepositorySource,
} from "./repository-source.js";

const commitResponseSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/i),
});

function endpoint(baseUrl: string, path: string): URL {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ""), normalizedBase);
}

export interface GitHubSnapshotClient {
  resolveCommit(input: {
    token: string;
    owner: string;
    repository: string;
    ref: string;
  }): Promise<string>;
  downloadArchive(input: {
    token: string;
    owner: string;
    repository: string;
    commitSha: string;
  }): Promise<Buffer>;
}

export class GitHubApiSnapshotClient implements GitHubSnapshotClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiVersion: string;
      timeoutMs?: number;
      maximumArchiveBytes?: number;
      fetchImplementation?: typeof fetch;
    },
  ) {}

  async resolveCommit(input: {
    token: string;
    owner: string;
    repository: string;
    ref: string;
  }): Promise<string> {
    const response = await this.request(
      endpoint(
        this.options.baseUrl,
        `repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(
          input.repository,
        )}/commits/${encodeURIComponent(input.ref)}`,
      ),
      input.token,
    );
    const parsed = commitResponseSchema.parse(await response.json());
    return parsed.sha.toLowerCase();
  }

  async downloadArchive(input: {
    token: string;
    owner: string;
    repository: string;
    commitSha: string;
  }): Promise<Buffer> {
    const response = await this.request(
      endpoint(
        this.options.baseUrl,
        `repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(
          input.repository,
        )}/tarball/${input.commitSha}`,
      ),
      input.token,
    );
    const maximumBytes = this.options.maximumArchiveBytes ?? 100 * 1_024 * 1_024;
    const declaredLength = Number(response.headers.get("content-length"));

    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new Error(`Repository archive exceeds ${maximumBytes} bytes`);
    }

    if (!response.body) {
      throw new Error("GitHub repository archive response had no body");
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      totalBytes += chunk.value.byteLength;

      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new Error(`Repository archive exceeds ${maximumBytes} bytes`);
      }

      chunks.push(Buffer.from(chunk.value));
    }

    return Buffer.concat(chunks);
  }

  private async request(url: URL, token: string): Promise<Response> {
    const fetchImplementation = this.options.fetchImplementation ?? fetch;
    const response = await fetchImplementation(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "DevSentinel/0.1.0",
        "X-GitHub-Api-Version": this.options.apiVersion,
      },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });

    if (!response.ok) {
      throw new GitHubApiError(
        `GitHub repository snapshot request failed with HTTP ${response.status}`,
        response.status,
        response.headers.get("x-github-request-id"),
      );
    }

    if (new URL(response.url || url).protocol !== "https:") {
      throw new Error("GitHub repository snapshot redirected away from HTTPS");
    }

    return response;
  }
}

export class GitHubRepositorySource implements RepositorySource {
  constructor(
    private readonly tokenProvider: InstallationTokenProvider,
    private readonly client: GitHubSnapshotClient,
    private readonly processRunner: ProcessRunner = new SpawnProcessRunner(),
  ) {}

  async materialize(
    target: RepositorySnapshotTarget,
  ): Promise<RepositorySnapshot> {
    const repository = splitRepositoryFullName(target.repositoryFullName);
    const tokenRequest = {
      installationId: target.githubInstallationId,
      repositoryId: target.githubRepositoryId,
      permissions: { metadata: "read", contents: "read" } as const,
    };
    let token = await this.tokenProvider.getToken(tokenRequest);
    let commitSha: string;
    let archive: Buffer;

    try {
      commitSha = await this.client.resolveCommit({
        token,
        ...repository,
        ref: target.ref,
      });
      archive = await this.client.downloadArchive({
        token,
        ...repository,
        commitSha,
      });
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 401) {
        throw error;
      }

      token = await this.tokenProvider.getToken({
        ...tokenRequest,
        refresh: true,
      });
      commitSha = await this.client.resolveCommit({
        token,
        ...repository,
        ref: target.ref,
      });
      archive = await this.client.downloadArchive({
        token,
        ...repository,
        commitSha,
      });
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), "devsentinel-run-"));
    const archivePath = join(temporaryRoot, "repository.tar.gz");
    const workspace = join(temporaryRoot, "workspace");

    try {
      await mkdir(workspace, { mode: 0o700 });
      await writeFile(archivePath, archive, { mode: 0o600 });
      const extraction = await this.processRunner.run({
        executable: "tar",
        args: [
          "--extract",
          "--gzip",
          "--file",
          archivePath,
          "--directory",
          workspace,
          "--strip-components=1",
          "--no-same-owner",
          "--no-same-permissions",
        ],
        timeoutMs: 60_000,
        outputLimitBytes: 64 * 1_024,
      });

      if (extraction.timedOut || extraction.exitCode !== 0) {
        throw new Error(
          extraction.timedOut
            ? "Repository archive extraction timed out"
            : `Repository archive extraction failed with exit code ${String(extraction.exitCode)}`,
        );
      }

      return {
        path: workspace,
        commitSha,
        async cleanup(): Promise<void> {
          await rm(temporaryRoot, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
  }
}
