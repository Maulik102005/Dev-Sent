import { createHash } from "node:crypto";
import { z } from "zod";

import { GitHubApiError, splitRepositoryFullName, type InstallationTokenProvider } from "./github-app-authorizer.js";
import { redact } from "./repair-policy.js";

export interface DiscussionEvidence {
  reference: string;
  author: string;
  createdAt: string;
  body: string;
  hash: string;
}

export interface IssueContextProvider {
  collect(input: {
    installationId: number;
    repositoryId: number;
    repositoryFullName: string;
    issueNumber: number;
  }): Promise<DiscussionEvidence[]>;
}

const commentSchema = z.object({
  id: z.number().int().positive(),
  body: z.string().nullable(),
  created_at: z.string(),
  user: z.object({ login: z.string() }).nullable(),
}).passthrough();

export class GitHubIssueContextProvider implements IssueContextProvider {
  constructor(private readonly tokens: InstallationTokenProvider, private readonly options: {
    baseUrl: string;
    apiVersion: string;
    fetchImplementation?: typeof fetch;
    maximumComments?: number;
    maximumBytes?: number;
  }) {}

  async collect(input: Parameters<IssueContextProvider["collect"]>[0]): Promise<DiscussionEvidence[]> {
    const { owner, repository } = splitRepositoryFullName(input.repositoryFullName);
    const tokenRequest = {
      installationId: input.installationId,
      repositoryId: input.repositoryId,
      permissions: { metadata: "read", issues: "read" } as const,
    };
    let token = await this.tokens.getToken(tokenRequest);
    const maximumComments = Math.min(this.options.maximumComments ?? 50, 100);
    const maximumBytes = Math.min(this.options.maximumBytes ?? 32 * 1024, 128 * 1024);
    const request = async (refresh = false) => {
      if (refresh) token = await this.tokens.getToken({ ...tokenRequest, refresh: true });
      const base = this.options.baseUrl.endsWith("/") ? this.options.baseUrl : `${this.options.baseUrl}/`;
      return (this.options.fetchImplementation ?? fetch)(new URL(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${input.issueNumber}/comments?per_page=${maximumComments}&page=1`, base), {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": this.options.apiVersion,
          "User-Agent": "DevSentinel",
        },
        signal: AbortSignal.timeout(30000),
      });
    };
    let response = await request();
    if (response.status === 401) response = await request(true);
    if (!response.ok) throw new GitHubApiError("GitHub issue context request failed", response.status, response.headers.get("x-github-request-id"));
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 1024 * 1024) throw new Error("GitHub issue context response exceeds its byte limit");
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("GitHub issue context response exceeds its byte limit");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error("GitHub issue context response is invalid JSON"); }
    const comments = z.array(commentSchema).max(maximumComments).parse(parsed);
    const evidence: DiscussionEvidence[] = [];
    let used = 0;
    for (const comment of comments) {
      const body = redact(comment.body ?? "").slice(0, 8_000);
      const bytes = Buffer.byteLength(body);
      if (used + bytes > maximumBytes) break;
      used += bytes;
      evidence.push({
        reference: `issue-comment:${comment.id}`,
        author: comment.user?.login ?? "unknown",
        createdAt: comment.created_at,
        body,
        hash: createHash("sha256").update(body).digest("hex"),
      });
    }
    return evidence;
  }
}

export const emptyIssueContextProvider: IssueContextProvider = { collect: async () => [] };
