import { describe, expect, it, vi } from "vitest";

import { GitHubIssueContextProvider } from "./issue-context.js";

describe("GitHub issue discussion evidence", () => {
  it("uses a read-only repository token, refreshes once, redacts secrets, and records stable references", async () => {
    const getToken = vi.fn().mockResolvedValueOnce("expired").mockResolvedValueOnce("fresh");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json([
        { id: 11, body: "Observed api token sk-12345678901234567890 in a log", created_at: "2026-09-10T00:00:00Z", user: { login: "reporter" } },
      ]));
    const provider = new GitHubIssueContextProvider({ getToken }, {
      baseUrl: "https://api.github.test", apiVersion: "2026-03-10", fetchImplementation: fetcher,
    });
    const evidence = await provider.collect({ installationId: 7, repositoryId: 8, repositoryFullName: "owner/repo", issueNumber: 9 });
    expect(evidence[0]).toMatchObject({ reference: "issue-comment:11", author: "reporter", body: "Observed api token [REDACTED TOKEN] in a log" });
    expect(evidence[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(getToken).toHaveBeenNthCalledWith(1, expect.objectContaining({ repositoryId: 8, permissions: { metadata: "read", issues: "read" } }));
    expect(getToken).toHaveBeenNthCalledWith(2, expect.objectContaining({ refresh: true }));
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer expired" });
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer fresh" });
  });

  it("stops at the configured evidence byte budget", async () => {
    const provider = new GitHubIssueContextProvider({ getToken: async () => "token" }, {
      baseUrl: "https://api.github.test", apiVersion: "2026-03-10", maximumBytes: 8,
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(Response.json([
        { id: 1, body: "12345678", created_at: "2026-09-10T00:00:00Z", user: null },
        { id: 2, body: "9", created_at: "2026-09-10T00:00:01Z", user: null },
      ])),
    });
    const evidence = await provider.collect({ installationId: 1, repositoryId: 2, repositoryFullName: "owner/repo", issueNumber: 3 });
    expect(evidence.map((item) => item.reference)).toEqual(["issue-comment:1"]);
  });
});
