import { createHash } from "node:crypto";
import type { getRunDetail } from "@devsentinel/database";
import { isTerminalRunStatus } from "@devsentinel/domain";
import { GitHubApiError, type InstallationTokenProvider } from "./github-app-authorizer.js";
import { editablePath, redact, type RepairProposal } from "./repair-policy.js";

export type RunDetail = NonNullable<Awaited<ReturnType<typeof getRunDetail>>>;
export interface DeliveryContext {
  detail: RunDetail;
  proposal: RepairProposal | null;
  guard(): Promise<void>;
  save(value: Record<string, unknown>): Promise<void>;
}
export interface ResultPublisher {
  publish(context: DeliveryContext): Promise<void>;
  progress?(context: DeliveryContext, update: { phase: string; message: string }): Promise<void>;
}

function humanStatus(detail: RunDetail, hasPatch: boolean): string {
  if (detail.run.status === "PUBLISHING" && hasPatch) return "Verified repair ready for review";
  if (detail.run.status === "SUCCEEDED") return hasPatch ? "Repair delivered for review" : "Checks completed";
  if (detail.run.status === "AWAITING_CLARIFICATION") return "Waiting for an answer";
  if (detail.run.status === "NEEDS_HUMAN") return "Needs review";
  if (detail.run.status === "BUDGET_EXHAUSTED") return "Needs review — run limit reached";
  if (detail.run.status === "REJECTED") return "Request not authorized";
  if (detail.run.status === "CANCELLED") return "Run cancelled";
  if (detail.run.status === "FAILED") return "Run could not complete";
  return detail.run.status.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function checkLabel(execution: { install?: { exitCode?: number | null; timedOut?: boolean }; test?: { exitCode?: number | null; timedOut?: boolean } | null } | null | undefined): string {
  if (!execution) return "Not run";
  if (execution.install?.timedOut || execution.test?.timedOut) return "Timed out";
  if (execution.install?.exitCode !== 0) return `Install failed (exit ${execution.install?.exitCode ?? "unknown"})`;
  return execution.test?.exitCode === 0 ? "Passed" : `Failed (exit ${execution.test?.exitCode ?? "unknown"})`;
}

function expectedFailureLabel(execution: Parameters<typeof checkLabel>[0]): string {
  if (!execution) return "Not run";
  if (execution.install?.timedOut || execution.test?.timedOut) return "Timed out";
  if (execution.install?.exitCode !== 0) return `Setup failed (exit ${execution.install?.exitCode ?? "unknown"})`;
  if (execution.test?.exitCode === 0) return "Unexpectedly passed";
  return `Failed as expected (exit ${execution.test?.exitCode ?? "unknown"})`;
}

function publicProgress(phase: string): { phase: string; message: string } {
  const known: Record<string, { phase: string; message: string }> = {
    Investigating: {
      phase: "Reviewing the issue",
      message: "DevSentinel is reading the relevant source and saving a focused plan before proposing any change.",
    },
    Verifying: {
      phase: "Running the checks",
      message: "DevSentinel is checking the reported behavior and then running the full test suite in an isolated workspace.",
    },
    Publishing: {
      phase: "Preparing the review",
      message: "The checks passed. DevSentinel is preparing the draft pull request and its supporting evidence.",
    },
  };
  return known[phase] ?? {
    phase: "Work in progress",
    message: "DevSentinel is working through the request. This comment will update when there is a meaningful result.",
  };
}

function publicReason(detail: RunDetail, hasPatch: boolean): string {
  if (detail.run.status === "PUBLISHING" && hasPatch) return "The proposed change passed the check for the reported problem and the full test suite.";
  if (detail.run.status === "SUCCEEDED") return hasPatch ? "The reviewed change was delivered successfully." : "The requested checks completed.";
  if (detail.run.status === "AWAITING_CLARIFICATION" || detail.run.failureClassification === "UNCLEAR_TASK") return "DevSentinel needs one specific answer before it can continue safely.";
  if (detail.run.failureClassification === "UNREPRODUCED_BUG") return "The reported behavior was not reproduced, so DevSentinel did not make a source change.";
  if (detail.run.failureClassification === "POLICY_BLOCKED") return "The requested change fell outside the approved repository or path policy.";
  if (detail.run.failureClassification === "UNSUCCESSFUL_PATCH") return "No proposed change passed the required checks.";
  if (detail.run.failureClassification === "BUDGET_EXHAUSTED") return "The run reached its configured safety limit and stopped without silently extending it.";
  if (detail.run.failureClassification === "PERMANENT_CONFIGURATION") return "A required service or repository setting needs attention before this can continue.";
  if (detail.run.failureClassification === "TRANSIENT_INFRASTRUCTURE") return "A temporary service or execution problem prevented the run from finishing.";
  if (detail.run.failureClassification === "VERIFIED_UNDELIVERED") return "The requested behavior passed, but another required check or delivery step still needs review.";
  if (detail.run.status === "CANCELLED") return "The run was cancelled at a safe checkpoint.";
  if (detail.run.status === "REJECTED") return "The request was not authorized to run.";
  return "The run stopped with saved evidence for review.";
}

function pullRequestTitle(detail: RunDetail): string {
  const issueTitle = redact(detail.taskBrief?.issueTitle ?? "").replace(/\s+/g, " ").trim();
  return `Fix: ${issueTitle || `issue #${detail.run.issueNumber}`}`.slice(0, 120);
}

export function resultSummary(detail: RunDetail, proposal: RepairProposal | null, deliveryMode?: "dry-run" | "github-app"): string {
  const attempt = detail.attempts.filter((item) => item.status === "VERIFIED").at(-1) ?? detail.attempts.at(-1);
  const verification = attempt?.verification;
  const targeted = attempt?.targetedVerification;
  const baseline = detail.executions.find((item) => item.phase === "BASELINE_TEST");
  const knownInput = detail.attempts.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0);
  const knownOutput = detail.attempts.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0);
  const unknownUsage = detail.attempts.filter((item) => item.inputTokens == null || item.outputTokens == null).length;
  const knownEstimatedCost = detail.attempts.reduce((sum, item) => sum + (item.estimatedCostMicrousd ?? 0), 0);
  const unknownEstimatedCost = detail.attempts.filter((item) => item.estimatedCostMicrousd == null).length;
  const mode = deliveryMode ?? (detail.workflow?.delivery.mode === "github-app" ? "github-app" : detail.workflow?.delivery.mode === "dry-run" ? "dry-run" : undefined);
  const acceptance = attempt?.acceptanceEvidence ?? [];
  const scope = [
    ...(detail.taskBrief?.approvedPaths ?? []),
    ...(detail.approvals ?? []).filter((item) => item.kind === "SCOPE_EXPANSION").flatMap((item) => item.paths),
  ];
  const nextAction = detail.run.status === "PUBLISHING" ? "Review the draft pull request. DevSentinel will not merge it."
    : detail.run.status === "AWAITING_CLARIFICATION" ? `Answer the saved question with \`/devsentinel continue ${detail.run.id} <answer>\`.`
    : detail.run.failureClassification === "VERIFIED_UNDELIVERED" ? "One or more required checks still need attention. Review them, then start a new run if the fix needs a wider scope."
    : "Review the note above. Once it is addressed, start a new scoped `/devsentinel` run.";
  const baselineResult = baseline
    ? baseline.timedOut ? "Timed out" : baseline.exitCode === 0 ? "Passed" : proposal ? `Failed — reported problem reproduced (exit ${baseline.exitCode})` : `Failed (exit ${baseline.exitCode})`
    : "Not recorded";
  const checkRows = [
    `| Existing suite on original code | ${baselineResult} |`,
    ...(attempt?.regressionBaseline ? [`| New regression check on original code | ${expectedFailureLabel(attempt.regressionBaseline)} |`] : []),
    ...(targeted ? [`| Requested behavior after the change | ${checkLabel(targeted)} |`] : []),
    ...(verification ? [`| Full suite after the change | ${checkLabel(verification)} |`] : []),
  ];
  const acceptanceLines = acceptance.length
    ? acceptance.map((item) => `- [${item.status === "SUPPORTED" ? "x" : " "}] ${redact(item.criterion)}${item.evidenceReferences.length ? `\n  <sub>Saved check evidence: ${item.evidenceReferences.map((reference) => `\`${redact(reference)}\``).join(", ")}</sub>` : ""}`)
    : ["- [ ] No acceptance check was linked to saved execution evidence."];
  const positiveOutcome = detail.run.status === "SUCCEEDED" || detail.run.status === "PUBLISHING" && Boolean(proposal);
  const visibleSummary = [
    "## DevSentinel review",
    `> **${positiveOutcome ? "✅" : "⚠️"} ${humanStatus(detail, Boolean(proposal))}**\n>\n> ${deliveryMode === "github-app" ? publicReason(detail, Boolean(proposal)) : redact(detail.run.statusReason ?? "The run finished with recorded evidence.").replace(/@/g, "@\u200b")}`,
    "### What you asked for",
    detail.taskBrief?.requestedOutcome ?? `Check issue #${detail.run.issueNumber}`,
    `**Approved scope:** ${scope.length ? scope.map((path) => `\`${path}\``).join(", ") : "Only source files allowed by the repository policy"}`,
    "### What changed",
    proposal ? `${redact(proposal.summary)}\n\n${proposal.edits.map((edit) => `- \`${edit.path}\``).join("\n")}` : "No change was prepared for delivery.",
    "### Checks run",
    ["| Check | Result |", "| --- | --- |", ...checkRows].join("\n"),
    "### Acceptance checks",
    acceptanceLines.join("\n"),
    ...((attempt?.unrelatedFailures ?? []).length
      ? ["### Still needs attention", attempt!.unrelatedFailures.map((failure) => `- ${redact(failure)}`).join("\n")]
      : []),
    "### Next step",
    nextAction,
    "<sub>Results come from the saved Docker test run for this exact revision. They support review, but do not replace it. DevSentinel never merges automatically.</sub>",
  ];
  if (deliveryMode !== "github-app") {
    visibleSummary.push(
      "### Operator record",
      [
        "| Internal detail | Recorded value |",
        "| --- | --- |",
        `| Run | \`${detail.run.id}\` |`,
        `| Snapshot | \`${detail.run.targetCommitSha ?? "not captured"}\` |`,
        `| Delivery | ${mode === "dry-run" ? "Dry run — no GitHub writes" : "Not attempted"} |`,
        `| Classification | ${detail.run.failureClassification ?? "None"} |`,
        `| Repair attempts | ${detail.attempts.length} |`,
        `| Reserved model allowance | ${detail.workflow?.reservedTokens ?? 0} units |`,
        `| Recorded model usage | ${knownInput} input / ${knownOutput} output tokens${unknownUsage ? ` (partial totals; ${unknownUsage} attempt(s) have unknown usage)` : ""} |`,
        `| Tool allowance used | ${detail.workflow?.toolCallCount ?? 0} call(s), ${detail.workflow?.toolOutputBytes ?? 0} output byte(s) |`,
        `| Configured-rate estimate | ${unknownEstimatedCost ? "Unknown or partial" : `$${(knownEstimatedCost / 1_000_000).toFixed(6)}`}${knownEstimatedCost && unknownEstimatedCost ? `; known portion $${(knownEstimatedCost / 1_000_000).toFixed(6)}` : ""} |`,
      ].join("\n"),
      "Reservations are admission limits, not an invoice. They stay charged when an external result may have been lost.",
    );
  }
  visibleSummary.push(`<!-- devsentinel-run:${detail.run.id} -->`);
  return visibleSummary.join("\n\n");
}

export class DryRunPublisher implements ResultPublisher {
  async publish(context: DeliveryContext): Promise<void> {
    await context.guard();
    await context.save({ mode: "dry-run", summary: resultSummary(context.detail, context.proposal, "dry-run") });
  }
}

export class GitHubResultPublisher implements ResultPublisher {
  constructor(private readonly tokens: InstallationTokenProvider, private readonly options: {
    appId: number; baseUrl: string; apiVersion: string; fetchImplementation?: typeof fetch;
  }) {}

  async progress(context: DeliveryContext, update: { phase: string; message: string }): Promise<void> {
    const { run } = context.detail;
    await context.guard();
    const token = await this.tokens.getToken({
      installationId: run.githubInstallationId,
      repositoryId: run.githubRepositoryId,
      permissions: { metadata: "read", issues: "write" },
    });
    const repo = `repos/${run.repositoryFullName.split("/").map(encodeURIComponent).join("/")}`;
    const request = async (method: string, path: string, body?: unknown): Promise<any> => {
      await context.guard();
      const response = await (this.options.fetchImplementation ?? fetch)(new URL(path, this.options.baseUrl.endsWith("/") ? this.options.baseUrl : `${this.options.baseUrl}/`), {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": this.options.apiVersion, "User-Agent": "DevSentinel" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000), redirect: "error",
      });
      if (!response.ok) throw new GitHubApiError(`GitHub progress delivery failed: HTTP ${response.status}`, response.status, response.headers.get("x-github-request-id"));
      return response.json();
    };
    const marker = `<!-- devsentinel-run:${run.id} -->`;
    const comments: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const items = await request("GET", `${repo}/issues/${run.issueNumber}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new Error("Unexpected GitHub comment list response");
      comments.push(...items);
      if (items.length < 100) break;
      if (page === 20) throw new Error("GitHub progress reconciliation page budget exceeded");
    }
    const current = comments.find((item) => item.performed_via_github_app?.id === this.options.appId && item.body?.includes(marker));
    const progress = publicProgress(update.phase);
    const body = [
      "## DevSentinel is checking this issue",
      `**${progress.phase}**`,
      progress.message,
      "_This comment updates at key stages. The issue is not considered fixed until the checks finish and a reviewer approves the result._",
      marker,
    ].join("\n\n");
    const comment = current
      ? await request("PATCH", `${repo}/issues/comments/${current.id}`, { body })
      : await request("POST", `${repo}/issues/${run.issueNumber}/comments`, { body });
    await context.save({ commentId: comment.id, mode: "github-app", progress: { phase: update.phase, updatedAt: new Date().toISOString() } });
  }

  async publish(context: DeliveryContext): Promise<void> {
    const { run } = context.detail;
    if (!isTerminalRunStatus(run.status) && run.status !== "PUBLISHING") throw new Error("Run is not ready for delivery");
    await context.guard();
    const token = await this.tokens.getToken({ installationId: run.githubInstallationId, repositoryId: run.githubRepositoryId,
      permissions: { metadata: "read", contents: context.proposal ? "write" : "read", issues: "write", checks: "write", ...(context.proposal ? { pull_requests: "write" as const } : {}) } });
    const repo = `repos/${run.repositoryFullName.split("/").map(encodeURIComponent).join("/")}`;
    const request = async (method: string, path: string, body?: unknown, allow404 = false): Promise<any> => {
      await context.guard();
      const response = await (this.options.fetchImplementation ?? fetch)(new URL(path, this.options.baseUrl.endsWith("/") ? this.options.baseUrl : `${this.options.baseUrl}/`), {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": this.options.apiVersion, "User-Agent": "DevSentinel" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000), redirect: "error",
      });
      if (allow404 && response.status === 404) return null;
      if (!response.ok) throw new GitHubApiError(`GitHub delivery failed: HTTP ${response.status}`, response.status, response.headers.get("x-github-request-id"));
      return response.status === 204 ? null : response.json();
    };
    const list = async (path: string, key?: string): Promise<any[]> => {
      const values: any[] = [];
      for (let page = 1; page <= 20; page++) {
        const data = await request("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
        const items = key ? data[key] : data;
        if (!Array.isArray(items)) throw new Error("Unexpected GitHub list response");
        values.push(...items);
        if (items.length < 100) return values;
      }
      throw new Error("GitHub reconciliation page budget exceeded");
    };
    let headSha = run.targetCommitSha;
    const summary = resultSummary(context.detail, context.proposal, "github-app");
    let prUrl: string | null = null;
    if (context.proposal) {
      if (run.status !== "PUBLISHING" || !headSha || !context.detail.attempts.some((item) => item.status === "VERIFIED")) throw new Error("Refusing to publish an unverified patch");
      const eligible = context.detail.attempts.filter((item) => item.status === "VERIFIED" && item.deliveryEligible).at(-1);
      if (!eligible) throw new Error("Refusing to publish a patch without delivery-eligible execution evidence");
      for (const edit of context.proposal.edits) {
        if (editablePath(edit.path)) continue;
        const regression = eligible.regressionTest;
        const hash = createHash("sha256").update(edit.content).digest("hex");
        const failedBefore = eligible.regressionBaseline?.install.exitCode === 0 && !eligible.regressionBaseline.install.timedOut &&
          eligible.regressionBaseline.test?.exitCode !== 0 && !eligible.regressionBaseline.test?.timedOut;
        const passedAfter = eligible.regressionCandidate?.install.exitCode === 0 && !eligible.regressionCandidate.install.timedOut &&
          eligible.regressionCandidate.test?.exitCode === 0 && !eligible.regressionCandidate.test.timedOut;
        if (!regression || regression.path !== edit.path || regression.content !== edit.content || regression.hash !== hash || !failedBefore || !passedAfter) {
          throw new Error("Refusing to publish an unverified or altered regression test");
        }
      }
      const branch = `devsentinel/run-${run.id}`;
      const owner = run.repositoryFullName.split("/")[0]!;
      const matches = await list(`${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(run.defaultBranch)}`);
      const previous = matches.find((pr) => pr.body?.includes(`<!-- devsentinel-run:${run.id} -->`));
      if (previous) {
        const commit = await request("GET", `${repo}/git/commits/${previous.head.sha}`);
        if (commit.parents?.length !== 1 || commit.parents[0].sha !== run.targetCommitSha) throw new Error("Existing PR was modified; review is required");
        headSha = previous.head.sha;
        prUrl = previous.html_url;
      } else {
        const current = await request("GET", `${repo}/commits/${encodeURIComponent(run.defaultBranch)}`);
        if (current.sha !== run.targetCommitSha) throw new Error("Default branch changed since verification; start a new run");
        const base = await request("GET", `${repo}/git/commits/${run.targetCommitSha}`);
        if (!this.tokens.getAppToken) throw new Error("Configured GitHub App identity resolver is unavailable");
        await context.guard();
        const appToken = await this.tokens.getAppToken();
        await context.guard();
        const baseUrl = this.options.baseUrl.endsWith("/") ? this.options.baseUrl : `${this.options.baseUrl}/`;
        const appResponse = await (this.options.fetchImplementation ?? fetch)(new URL("app", baseUrl), {
          headers: { Authorization: `Bearer ${appToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": this.options.apiVersion, "User-Agent": "DevSentinel" },
          signal: AbortSignal.timeout(30000), redirect: "error",
        });
        if (!appResponse.ok) throw new GitHubApiError(`GitHub App identity lookup failed: HTTP ${appResponse.status}`, appResponse.status, appResponse.headers.get("x-github-request-id"));
        const app = await appResponse.json() as { slug?: unknown };
        if (typeof app.slug !== "string" || !/^[a-z0-9-]{1,100}$/.test(app.slug)) throw new Error("Configured GitHub App returned an invalid bot identity");
        const login = `${app.slug}[bot]`;
        const bot = await request("GET", `users/${encodeURIComponent(login)}`) as { id?: unknown; login?: unknown };
        if (typeof bot.id !== "number" || !Number.isSafeInteger(bot.id) || typeof bot.login !== "string" || bot.login !== login) {
          throw new Error("Configured GitHub App bot account could not be resolved");
        }
        const identity = { name: bot.login, email: `${bot.id}+${bot.login}@users.noreply.github.com`, date: run.createdAt.toISOString() };
        const tree = await request("POST", `${repo}/git/trees`, { base_tree: base.tree.sha, tree: context.proposal.edits.map((edit) => ({ path: edit.path, mode: "100644", type: "blob", content: edit.content })) });
        const commit = await request("POST", `${repo}/git/commits`, { message: pullRequestTitle(context.detail), tree: tree.sha, parents: [run.targetCommitSha], author: identity, committer: identity });
        headSha = commit.sha;
        const ref = await request("GET", `${repo}/git/ref/heads/${branch}`, undefined, true);
        if (ref && ref.object?.sha !== headSha) throw new Error("Delivery branch already exists with different content; refusing to overwrite it");
        if (!ref) await request("POST", `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: headSha });
        await context.save({ branch, headSha });
        const pr = await request("POST", `${repo}/pulls`, { title: pullRequestTitle(context.detail), head: branch, base: run.defaultBranch, draft: true, body: `${summary}\n\nRelated to #${run.issueNumber}.` });
        prUrl = pr.html_url;
      }
      // Reconcile the tree even after a lost POST response. Never trust a matching marker alone.
      const candidate = await request("GET", `${repo}/git/commits/${headSha}`);
      const base = await request("GET", `${repo}/git/commits/${run.targetCommitSha}`);
      const expectedTree = await request("POST", `${repo}/git/trees`, { base_tree: base.tree.sha, tree: context.proposal.edits.map((edit) => ({ path: edit.path, mode: "100644", type: "blob", content: edit.content })) });
      if (candidate.tree.sha !== expectedTree.sha || candidate.parents?.length !== 1 || candidate.parents[0].sha !== run.targetCommitSha) throw new Error("Published commit does not match verified patch");
      await context.save({ headSha, pullRequestUrl: prUrl });
    }
    if (headSha) {
      const checks = await list(`${repo}/commits/${headSha}/check-runs?filter=all`, "check_runs");
      let check = checks.find((item) => item.external_id === run.id && item.app?.id === this.options.appId);
      const success = Boolean(context.proposal) || run.status === "SUCCEEDED";
      const body = { name: "DevSentinel", head_sha: headSha, external_id: run.id, status: "completed", conclusion: success ? "success" : "failure", output: { title: success ? "Sandbox tests passed" : "Run needs attention", summary } };
      if (check) await request("PATCH", `${repo}/check-runs/${check.id}`, { status: body.status, conclusion: body.conclusion, output: body.output });
      else check = await request("POST", `${repo}/check-runs`, body);
      await context.save({ checkRunId: check.id });
    }
    const marker = `<!-- devsentinel-run:${run.id} -->`;
    const comments = await list(`${repo}/issues/${run.issueNumber}/comments`);
    let comment = comments.find((item) => item.performed_via_github_app?.id === this.options.appId && item.body?.includes(marker));
    const body = `${summary}${prUrl ? `\n\n### Pull request\n\n[Open the draft pull request](${prUrl})` : ""}`;
    if (comment) await request("PATCH", `${repo}/issues/comments/${comment.id}`, { body });
    else comment = await request("POST", `${repo}/issues/${run.issueNumber}/comments`, { body });
    await context.save({ commentId: comment.id, mode: "github-app" });
  }
}
