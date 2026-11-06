import { describe, expect, it, vi } from "vitest";
import { GitHubResultPublisher, resultSummary, type RunDetail } from "./github-delivery.js";

const baseSha = "a".repeat(40), patchSha = "b".repeat(40);
const runId = "b173e43c-0c38-4c3c-9cb9-66fbd2c8eb74";
const proposal = { summary: "Correct quantity calculation.", edits: [{ path: "src/total.js", content: "fixed" }] };
function detail(): RunDetail {
  return {
    run: { id: runId, mode: "FIX", status: "PUBLISHING", repositoryFullName: "owner/repo", githubInstallationId: 1, githubRepositoryId: 2, targetCommitSha: baseSha, defaultBranch: "main", issueNumber: 4, createdAt: new Date("2026-09-01T00:00:00Z"), statusReason: "verified" },
    taskBrief: { issueTitle: "Quantity boundary is incorrect", requestedOutcome: "Correct quantity totals", approvedPaths: ["src/total.js"] },
    workflow: { delivery: {}, reservedTokens: 1000 },
    attempts: [{
      status: "VERIFIED",
      proposal,
      verification: { install: { exitCode: 0 }, test: { exitCode: 0 } },
      targetedVerification: { test: { exitCode: 0 } },
      acceptanceEvidence: [{ criterion: "The quantity calculation is correct", status: "SUPPORTED", evidenceReferences: ["baseline:test", "candidate:test"] }],
      unrelatedFailures: [],
      requiredChecksPassed: true,
      deliveryEligible: true,
    }],
    executions: [{ phase: "BASELINE_TEST", exitCode: 1 }], events: [],
  } as unknown as RunDetail;
}
function github() {
  const state = {
    prs: [] as any[], comments: [] as any[], checks: [] as any[], ref: null as any,
    current: baseSha, candidateTree: "patch-tree", appSlug: "configured-sentinel" as string | null,
    losePrResponse: false, loseCommentResponse: false,
    requests: [] as { method: string; path: string; body: any }[],
  };
  const fetcher: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace("/repos/owner/repo/", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : null;
    state.requests.push({ method, path, body });
    const json = (value: unknown) => Response.json(value);
    if (method === "GET" && path === "/app") return json({ slug: state.appSlug });
    if (method === "GET" && path === "/users/configured-sentinel%5Bbot%5D") return json({ id: 42001, login: "configured-sentinel[bot]" });
    if (method === "GET" && path === "pulls") return json(state.prs);
    if (method === "GET" && path === "commits/main") return json({ sha: state.current });
    if (method === "GET" && path === `git/commits/${baseSha}`) return json({ tree: { sha: "base-tree" }, parents: [] });
    if (method === "GET" && path === `git/commits/${patchSha}`) return json({ tree: { sha: state.candidateTree }, parents: [{ sha: baseSha }] });
    if (method === "POST" && path === "git/trees") return json({ sha: "patch-tree" });
    if (method === "POST" && path === "git/commits") return json({ sha: patchSha });
    if (method === "GET" && path.startsWith("git/ref/")) return state.ref ? json(state.ref) : new Response(null, { status: 404 });
    if (method === "POST" && path === "git/refs") { state.ref = { object: { sha: body.sha } }; return json(state.ref); }
    if (method === "POST" && path === "pulls") {
      const pr = { number: 5, body: body.body, head: { sha: patchSha }, html_url: "https://github.com/owner/repo/pull/5" };
      state.prs.push(pr);
      if (state.losePrResponse) { state.losePrResponse = false; throw new Error("Connection lost after PR creation"); }
      return json(pr);
    }
    if (method === "GET" && path.endsWith("/check-runs")) return json({ check_runs: state.checks });
    if (method === "POST" && path === "check-runs") { const check = { ...body, id: 6, app: { id: 7 } }; state.checks.push(check); return json(check); }
    if (method === "PATCH" && path === "check-runs/6") return json(state.checks[0]);
    if (method === "GET" && path === "issues/4/comments") {
      const page = Number(parsed.searchParams.get("page") ?? "1");
      return json(state.comments.slice((page - 1) * 100, page * 100));
    }
    if (method === "POST" && path === "issues/4/comments") {
      const comment = { id: 8, body: body.body, performed_via_github_app: { id: 7 } }; state.comments.push(comment);
      if (state.loseCommentResponse) { state.loseCommentResponse = false; throw new Error("Connection lost after comment creation"); }
      return json(comment);
    }
    if (method === "PATCH" && path.startsWith("issues/comments/")) {
      const id = Number(path.split("/").at(-1));
      const comment = state.comments.find((item) => item.id === id);
      if (!comment) return new Response(null, { status: 404 });
      comment.body = body.body;
      return json(comment);
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  const getToken = vi.fn().mockResolvedValue("short-lived-test-token");
  const getAppToken = vi.fn().mockResolvedValue("app-jwt");
  const publisher = new GitHubResultPublisher({ getToken, getAppToken }, { appId: 7, baseUrl: "https://api.github.com", apiVersion: "2026-03-10", fetchImplementation: fetcher });
  const context = { detail: detail(), proposal, guard: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue(undefined) };
  return { state, publisher, context, getToken };
}
describe("GitHub result delivery", () => {
  it("reconciles one meaningful progress comment per run", async () => {
    const { state, publisher, context } = github();
    await publisher.progress(context, { phase: "Investigating", message: "Attempt 3; reserved token units: 55128; estimated cost $1.23." });
    await publisher.progress(context, { phase: "Verifying", message: "Running required checks." });
    expect(state.comments).toHaveLength(1);
    expect(state.requests.filter((request) => request.method === "PATCH" && request.path === "issues/comments/8")).toHaveLength(1);
    expect(state.comments[0].body).toContain("devsentinel-run:");
    expect(state.comments[0].body).toContain("Running the checks");
    expect(state.comments[0].body).not.toMatch(/token|cost|reserved|attempt 3/i);
  });
  it("finds an older App-owned progress comment through bounded pagination", async () => {
    const { state, publisher, context } = github();
    state.comments.push(
      ...Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: "unrelated", performed_via_github_app: { id: 99 } })),
      { id: 108, body: `old\n<!-- devsentinel-run:${runId} -->`, performed_via_github_app: { id: 7 } },
    );
    await publisher.progress(context, { phase: "Verifying", message: "Running required checks." });
    expect(state.comments).toHaveLength(101);
    expect(state.requests.some((request) => request.method === "POST" && request.path === "issues/4/comments")).toBe(false);
    expect(state.requests.some((request) => request.method === "PATCH" && request.path === "issues/comments/108")).toBe(true);
  });
  it("publishes a draft PR, check, and comment using repo-scoped permissions", async () => {
    const { state, publisher, context, getToken } = github();
    await publisher.publish(context);
    expect(state.prs).toHaveLength(1); expect(state.checks).toHaveLength(1); expect(state.comments).toHaveLength(1);
    expect(state.requests.find((r) => r.method === "POST" && r.path === "pulls")?.body).toMatchObject({ title: "Fix: Quantity boundary is incorrect", draft: true, head: `devsentinel/run-${runId}`, base: "main" });
    expect(state.requests.find((r) => r.method === "POST" && r.path === "git/commits")?.body.message).toBe("Fix: Quantity boundary is incorrect");
    expect(state.requests.some((r) => r.method === "PATCH" && r.path.startsWith("git/"))).toBe(false);
    expect(getToken).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: 2, permissions: expect.objectContaining({ contents: "write", pull_requests: "write", checks: "write" }) }));
    expect(state.checks[0].head_sha).toBe(patchSha);
    expect(state.prs[0].body).toContain("### What changed");
    expect(state.prs[0].body).toContain("### Acceptance checks");
    expect(state.prs[0].body).not.toMatch(/token|cost|reserved|repair attempts/i);
    expect(state.comments[0].body).toContain("Open the draft pull request");
    expect(state.comments[0].body).not.toMatch(/token|cost|reserved|repair attempts/i);
    const identity = { name: "configured-sentinel[bot]", email: "42001+configured-sentinel[bot]@users.noreply.github.com" };
    expect(state.requests.find((r) => r.method === "POST" && r.path === "git/commits")?.body).toMatchObject({ author: identity, committer: identity });
  });
  it("fails closed before creating Git objects when configured App authorship cannot be resolved", async () => {
    const { state, publisher, context } = github();
    state.appSlug = null;
    await expect(publisher.publish(context)).rejects.toThrow("invalid bot identity");
    expect(state.requests.some((request) => request.method === "POST" && request.path.startsWith("git/"))).toBe(false);
    expect(state.prs).toHaveLength(0);
  });
  it.each(["losePrResponse", "loseCommentResponse"] as const)("reconciles %s without creating duplicates", async (failure) => {
    const { state, publisher, context } = github();
    state[failure] = true;
    await expect(publisher.publish(context)).rejects.toThrow("Connection lost");
    await publisher.publish(context);
    await publisher.publish(context);
    expect(state.prs).toHaveLength(1); expect(state.comments).toHaveLength(1); expect(state.checks).toHaveLength(1);
  });
  it("does not publish a patch if the default branch moved", async () => {
    const { state, publisher, context } = github(); state.current = "c".repeat(40);
    await expect(publisher.publish(context)).rejects.toThrow("Default branch changed");
    expect(state.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });
  it("does not overwrite a conflicting branch", async () => {
    const { state, publisher, context } = github(); state.ref = { object: { sha: "c".repeat(40) } };
    await expect(publisher.publish(context)).rejects.toThrow("refusing to overwrite");
    expect(state.prs).toHaveLength(0);
  });
  it("does not mark a modified PR as verified", async () => {
    const { state, publisher, context } = github();
    state.prs.push({ body: `<!-- devsentinel-run:${runId} -->`, head: { sha: patchSha }, html_url: "https://github.com/owner/repo/pull/5" });
    state.candidateTree = "tampered-tree";
    await expect(publisher.publish(context)).rejects.toThrow("does not match verified patch");
    expect(state.checks).toHaveLength(0); expect(state.comments).toHaveLength(0);
  });
  it("reports TEST results without creating commits or pull requests", async () => {
    const { state, publisher, context, getToken } = github();
    context.detail.run.mode = "TEST"; context.detail.run.status = "FAILED";
    await publisher.publish({ ...context, proposal: null });
    expect(state.prs).toHaveLength(0);
    expect(state.requests.some((r) => r.method === "POST" && r.path.startsWith("git/"))).toBe(false);
    expect(getToken.mock.calls[0]?.[0].permissions.contents).toBe("read");
    expect(state.checks[0].conclusion).toBe("failure");
  });
  it("blocks external writes when the cancellation guard fails", async () => {
    const { state, publisher, context } = github(); context.guard.mockRejectedValue(new Error("cancelled"));
    await expect(publisher.publish(context)).rejects.toThrow("cancelled");
    expect(state.requests).toHaveLength(0);
  });
  it("does not publish raw test output or leaked secrets in summaries", () => {
    const data = detail(); data.run.statusReason = "api_key=sk-12345678901234567890";
    const text = resultSummary(data, null);
    expect(text).not.toContain("123456789");
  });
  it("labels missing legacy usage as unknown rather than zero billed tokens", () => {
    const text = resultSummary(detail(), null);
    expect(text).toContain("partial totals; 1 attempt(s) have unknown usage");
    expect(text).toContain("Reservations are admission limits, not an invoice");
  });
  it("keeps internal usage and cost details out of GitHub-facing reports", () => {
    const text = resultSummary(detail(), proposal, "github-app");
    expect(text).toContain("Verified repair ready for review");
    expect(text).toContain("✅");
    expect(text).toContain("reported problem reproduced");
    expect(text).toContain("Saved check evidence");
    expect(text).not.toMatch(/token|cost|reserved|repair attempts|operator record/i);
  });
  it("presents a successful TEST run as a positive result without inventing a patch", () => {
    const data = detail();
    data.run.mode = "TEST";
    data.run.status = "SUCCEEDED";
    const text = resultSummary(data, null, "github-app");
    expect(text).toContain("✅ Checks completed");
    expect(text).toContain("No change was prepared for delivery");
    expect(text).not.toMatch(/token|cost|reserved|repair attempts|operator record/i);
  });
});
