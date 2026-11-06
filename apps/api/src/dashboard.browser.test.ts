import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDatabase,
  ingestWebhook,
  migrateDatabase,
  outboxEvents,
  repairAttempts,
  runContextItems,
  runEvents,
  runPlans,
  runs,
  runTaskBriefs,
  runWorkflows,
  sandboxExecutions,
} from "@devsentinel/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  readonly exceptions: string[] = [];

  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") {
        this.exceptions.push(message.params?.exceptionDetails?.text ?? "Browser runtime exception");
      }
    });
  }

  static async connect(url: string) {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome DevTools")), { once: true });
    });
    return new Cdp(socket);
  }

  command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() { this.socket.close(); }
}

const database = createDatabase(process.env.TEST_DATABASE_URL!);
const token = "browser-control-token-at-least-32-characters";
const app = buildApp({
  db: database.db,
  webhookSecret: "browser-webhook-secret",
  controlToken: token,
  readiness: { authorizationMode: "github-app", repositorySourceMode: "github-app", agentModelEnabled: true, deliveryMode: "dry-run", allowedRepositoryCount: 1 },
});
let chrome: ChildProcessWithoutNullStreams;
let profile = "";
let cdp: Cdp;
let sessionId = "";
let dashboardUrl = "";

async function evaluate<T>(expression: string): Promise<T> {
  const result = await cdp.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value as T;
}

async function waitFor(expression: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate<boolean>(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Browser condition timed out: ${expression}`);
}

beforeAll(async () => {
  await migrateDatabase(database.db);
  await database.client.unsafe("TRUNCATE TABLE outbox_events, runs, webhook_deliveries CASCADE");
  const created = await ingestWebhook(database.db, {
    deliveryId: randomUUID(), eventName: "issue_comment", action: "created", payload: { fixture: true },
    trigger: {
      installationId: 1, repositoryId: 2, repositoryFullName: "owner/checkout", defaultBranch: "main", issueNumber: 17,
      actorLogin: "maintainer", activation: "command", mode: "FIX", issueTitle: "Quantity boundary is incorrect",
      issueBody: "- [ ] Three items cost three unit prices", triggerComment: "/devsentinel fix\nScope: src/total.js",
      commandContext: { raw: "Scope: src/total.js", requestedOutcome: "Correct quantity totals", acceptanceCriteria: ["Three items cost three unit prices"], constraints: [], approvedPaths: ["src/total.js"], excludedPaths: [] },
    },
  });
  if (created.kind !== "accepted") throw new Error("Browser run fixture was not created");
  const runId = created.runId;
  const now = new Date();
  const command = (exitCode: number, stdout: string) => ({
    command: ["npm", "test"],
    exitCode,
    timedOut: false,
    durationMs: 41,
    stdout,
    stderr: "",
    outputTruncated: false,
  });
  const candidate = { image: "node:22-test", install: command(0, "dependencies already locked"), test: command(0, "# pass 1\n# fail 0") };
  await database.db.update(runs).set({
    status: "SUCCEEDED",
    statusReason: "Acceptance criteria are supported by recorded execution evidence; dry-run report completed",
    failureClassification: null,
    targetCommitSha: "a".repeat(40),
    detectedPackageManager: "npm",
    baselineCompletedAt: now,
    updatedAt: now,
  }).where(eq(runs.id, runId));
  await database.db.update(runTaskBriefs).set({
    capturedCommitSha: "a".repeat(40),
    guidancePath: "DEVSENTINEL.md",
    guidanceHash: "b".repeat(64),
    guidanceVersion: "1",
    guidanceContent: "Preserve issue scope.",
    sealedAt: now,
  }).where(eq(runTaskBriefs.runId, runId));
  await database.db.insert(runWorkflows).values({
    runId,
    reservedTokens: 9_000,
    attemptCount: 1,
    toolCallCount: 3,
    toolOutputBytes: 720,
    inspectorQueryCount: 0,
    inspectorReservedTokens: 0,
    delivery: { mode: "dry-run", summary: "Execution-supported repair; no GitHub writes." },
    deliveryCompletedAt: now,
  });
  await database.db.insert(runPlans).values({
    runId,
    suspectedCause: "The total adds quantity instead of multiplying by it.",
    evidenceReferences: ["src/total.js:1", "baseline-test"],
    intendedFiles: ["src/total.js"],
    scopeExclusions: ["Shipping and unrelated behavior"],
    verificationSteps: ["Run quantity profile", "Run required full suite"],
  });
  await database.db.insert(runContextItems).values({
    runId,
    attemptIteration: 1,
    kind: "source",
    source: "captured-revision",
    reference: "src/total.js",
    contentHash: "c".repeat(64),
    content: "export function total(price, quantity) { return price + quantity; }\n",
    byteCount: 68,
    selected: true,
    note: "selected by bounded relevance",
  });
  await database.db.insert(repairAttempts).values({
    runId,
    iteration: 1,
    status: "VERIFIED",
    reservedTokens: 9_000,
    inputTokens: 25,
    outputTokens: 10,
    estimatedCostMicrousd: 45,
    toolCalls: 3,
    toolOutputBytes: 720,
    toolTrace: [
      { sequence: 1, phase: "INVESTIGATE", tool: "search_code", summary: "found quantity calculation", outputBytes: 180 },
      { sequence: 2, phase: "INVESTIGATE", tool: "read_text", summary: "read src/total.js", outputBytes: 220 },
      { sequence: 3, phase: "PLAN", tool: "submit_plan", summary: "submitted one-file plan", outputBytes: 320 },
    ],
    proposal: {
      summary: "Multiply the unit price by quantity.",
      edits: [{ path: "src/total.js", content: "export function total(price, quantity) { return price * quantity; }\n" }],
    },
    targetedVerification: candidate,
    verification: candidate,
    acceptanceEvidence: [{ criterion: "Three items cost three unit prices", status: "SUPPORTED", evidenceReferences: ["targeted-test:quantity", "candidate-full-suite"] }],
    unrelatedFailures: [],
    requiredChecksPassed: true,
    deliveryEligible: true,
    reason: "Recorded targeted and full-suite execution passed",
  });
  await database.db.insert(sandboxExecutions).values([
    { runId, phase: "DEPENDENCY_INSTALL", image: "node:22-test", ...command(0, "dependencies already locked") },
    { runId, phase: "BASELINE_TEST", image: "node:22-test", ...command(1, "not ok 1 - quantity total") },
  ]);
  await database.db.insert(runEvents).values([
    { runId, kind: "task.sealed", message: "Captured immutable task brief and revision." },
    { runId, kind: "verification.passed", message: "Targeted and required full-suite execution passed." },
    { runId, kind: "delivery.completed", message: "Dry-run evidence saved; no GitHub writes." },
  ]);
  await database.db.update(outboxEvents).set({ publishedAt: now }).where(eq(outboxEvents.aggregateId, runId));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Browser test server has no TCP address");
  dashboardUrl = `http://127.0.0.1:${address.port}/dashboard`;
  profile = await mkdtemp(join(tmpdir(), "devsentinel-browser-"));
  chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "--window-size=1440,1000", "about:blank",
  ], { stdio: "pipe" });
  const debuggerUrl = await new Promise<string>((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Chrome DevTools endpoint did not start: ${stderr.slice(-1000)}`)), 10_000);
    chrome.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (match) { clearTimeout(timeout); resolve(match[1]!); }
    });
    chrome.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Chrome exited early with ${code}: ${stderr.slice(-1000)}`)); });
  });
  cdp = await Cdp.connect(debuggerUrl);
  const target = await cdp.command("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  sessionId = attached.sessionId;
  await cdp.command("Runtime.enable", {}, sessionId);
  await cdp.command("Page.enable", {}, sessionId);
  await cdp.command("Page.navigate", { url: dashboardUrl }, sessionId);
  await waitFor("location.pathname === '/dashboard' && document.readyState === 'complete'");
});

afterAll(async () => {
  cdp?.close();
  if (chrome && chrome.exitCode == null) {
    const exited = new Promise<void>((resolve) => chrome.once("exit", () => resolve()));
    chrome.kill("SIGTERM");
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    if (chrome.exitCode == null) {
      const killed = new Promise<void>((resolve) => chrome.once("exit", () => resolve()));
      chrome.kill("SIGKILL");
      await killed;
    }
  }
  await app.close();
  await database.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

describe("developer review console browser journey", () => {
  it("handles access safely, opens real evidence, uses the inspector, and remains responsive", async () => {
    expect(await evaluate<string>("document.title")).toBe("DevSentinel · Review Console");
    expect(await evaluate<string>("document.querySelector('#auth-title').textContent")).toContain("See what happened");

    await cdp.command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, sessionId);
    expect(await evaluate<number>("parseFloat(getComputedStyle(document.querySelector('#theme-toggle')).transitionDuration)")).toBeLessThanOrEqual(0.001);
    await evaluate("document.querySelector('#theme-toggle').click(); true");
    expect(await evaluate<string>("document.documentElement.dataset.theme")).toBe("light");
    await evaluate("document.querySelector('#theme-toggle').click(); true");
    expect(await evaluate<string>("document.documentElement.dataset.theme")).toBe("dark");
    expect(await evaluate<string[]>("Object.keys(localStorage)")).toEqual(["devsentinel-theme"]);

    await evaluate("document.querySelector('#token').value = 'incorrect-access-key'; document.querySelector('#connect').requestSubmit(); true");
    await waitFor("document.querySelector('#auth-status').textContent.includes('Check your dashboard access key')");
    expect(await evaluate<boolean>("document.querySelector('#app-view').hidden")).toBe(true);

    await evaluate(`document.querySelector('#token').value = ${JSON.stringify(token)}; document.querySelector('#connect').requestSubmit(); true`);
    await waitFor("document.querySelector('#app-view').hidden === false && document.querySelectorAll('.readiness-card').length === 4");
    expect(await evaluate<number>("document.querySelectorAll('.run-item').length")).toBe(1);
    expect(await evaluate<string>("document.querySelector('.run-item-bottom span').textContent")).toBe("Repair");
    expect(await evaluate<string>("document.querySelector('#overview-copy').textContent")).toContain("GitHub access uses GitHub App");
    expect(await evaluate<string>("document.querySelector('#status-filter option[value=NEEDS_HUMAN]').textContent")).toBe("Needs review");
    expect(await evaluate<string>("document.querySelector('.brand-mark img').src")).toContain("avatars.githubusercontent.com/in/4855052");
    expect(await evaluate<boolean>(`location.href.includes(${JSON.stringify(token)})`)).toBe(false);
    expect(await evaluate<boolean>(`Object.values(localStorage).some(value => value.includes(${JSON.stringify(token)}))`)).toBe(false);
    expect(await evaluate<boolean>(`Object.values(sessionStorage).some(value => value.includes(${JSON.stringify(token)}))`)).toBe(false);
    expect(await evaluate<boolean>(`performance.getEntriesByType('resource').some(entry => entry.name.includes(${JSON.stringify(token)}))`)).toBe(false);

    await evaluate("document.querySelector('#home').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })); true");
    expect(await evaluate<string>("document.activeElement.id")).toBe("search");
    await evaluate("document.querySelector('#search').value = 'nothing-will-match-this'; document.querySelector('#search').dispatchEvent(new Event('input', { bubbles: true })); true");
    await waitFor("document.querySelectorAll('.run-item').length === 0 && document.querySelector('#run-list').textContent.includes('No matching runs')");
    await evaluate("document.querySelector('#search').value = ''; document.querySelector('#search').dispatchEvent(new Event('input', { bubbles: true })); true");
    await waitFor("document.querySelectorAll('.run-item').length === 1");

    await evaluate("document.querySelector('.run-item').click(); true");
    await waitFor("document.querySelector('#run-view').hidden === false && document.querySelector('#run-title').textContent.includes('Quantity boundary') && document.querySelector('#task-panel').textContent.includes('Three items cost three unit prices')");
    expect(await evaluate<string>("document.querySelector('#run-reason').textContent")).toContain("ready for review");
    const desktopColumns = await evaluate<{ primaryRight: number; secondaryLeft: number }>(`(() => {
      const primary = document.querySelector('.workspace-primary').getBoundingClientRect();
      const secondary = document.querySelector('.workspace-secondary').getBoundingClientRect();
      return { primaryRight: primary.right, secondaryLeft: secondary.left };
    })()`);
    expect(desktopColumns.primaryRight).toBeLessThan(desktopColumns.secondaryLeft);
    expect(await evaluate<string>("document.querySelector('#task-panel').textContent")).toContain("Three items cost three unit prices");
    expect(await evaluate<string>("document.querySelector('#changes-panel').textContent")).toContain("price * quantity");
    expect(await evaluate<string>("document.querySelector('#tests-panel').textContent")).toContain("candidate-full-suite");
    await evaluate("[...document.querySelectorAll('#logs-panel button')].find(button => button.textContent.includes('Baseline Test')).click(); true");
    expect(await evaluate<string>("document.querySelector('#logs-panel .log-view').textContent")).toContain("not ok 1 - quantity total");
    expect(await evaluate<string>("document.querySelector('#budget-panel').textContent")).toContain("$0.000045");
    expect(await evaluate<string>("document.querySelector('#delivery-panel').textContent")).toContain("Dry-run record");
    await evaluate("[...document.querySelectorAll('#prompt-grid button')].find(button => button.textContent.includes('Why did this fail')).click(); true");
    await waitFor("document.querySelectorAll('.answer-card').length === 1");
    expect(await evaluate<string>("document.querySelector('.answer-card footer').textContent")).toContain("Built-in answer · sources: run:status");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await evaluate<string>("document.querySelector('#logs-panel button.is-active').textContent")).toContain("Baseline Test");

    const desktop = await cdp.command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    await writeFile("/tmp/devsentinel-dashboard-desktop.png", Buffer.from(desktop.data, "base64"));
    await evaluate("document.querySelector('#theme-toggle').click(); true");
    await waitFor("document.documentElement.dataset.theme === 'light'");
    const light = await cdp.command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    await writeFile("/tmp/devsentinel-dashboard-light.png", Buffer.from(light.data, "base64"));
    await evaluate("document.querySelector('#theme-toggle').click(); true");
    await waitFor("document.documentElement.dataset.theme === 'dark'");
    await evaluate("document.querySelector('#changes-panel').scrollIntoView({block: 'start'}); true");
    const evidence = await cdp.command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    await writeFile("/tmp/devsentinel-dashboard-evidence.png", Buffer.from(evidence.data, "base64"));
    await evaluate("document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 0); true");
    await waitFor("window.scrollY === 0");
    // Keep the current document/session intact while exercising the 390 px
    // responsive breakpoint. Switching Chrome into mobile emulation after a
    // document is loaded requires a reload before viewport metadata is
    // reapplied, which would intentionally clear the in-memory bearer token.
    await cdp.command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sessionId);
    await waitFor("window.innerWidth === 390");
    const layout = await evaluate<{ viewport: number; scrollWidth: number; unexpected: Array<{ selector: string; left: number; right: number; width: number }> }>(`({
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      unexpected: [...document.body.querySelectorAll('*')]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            element,
            selector: element.id ? '#' + element.id : element.tagName.toLowerCase() + (element.className ? '.' + String(element.className).trim().replace(/\\s+/g, '.') : ''),
            left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width),
          };
        })
        .filter(({ element, left, right, width }) =>
          width > 0 && (left < -1 || right > window.innerWidth + 1) &&
          getComputedStyle(element).position !== 'fixed' &&
          !element.closest('.diff-grid, .log-view, .run-table-wrap, .run-list, .inspector-thread')
        )
        .map(({ element, ...rect }) => rect)
        .slice(0, 20)
    })`);
    expect(layout.viewport).toBe(390);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport);
    expect(layout.unexpected).toEqual([]);
    expect(await evaluate<boolean>("getComputedStyle(document.querySelector('.app-layout')).display !== 'none'")).toBe(true);
    const mobile = await cdp.command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    await writeFile("/tmp/devsentinel-dashboard-mobile.png", Buffer.from(mobile.data, "base64"));

    await evaluate("document.querySelector('#disconnect').click(); true");
    expect(await evaluate<boolean>("document.querySelector('#auth-view').hidden")).toBe(false);
    expect(await evaluate<string>("document.querySelector('#token').value")).toBe("");
    expect(await evaluate<boolean>(`Object.values(localStorage).some(value => value.includes(${JSON.stringify(token)}))`)).toBe(false);
    expect(cdp.exceptions).toEqual([]);
  });
});
