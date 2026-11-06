import { createHmac, randomUUID } from "node:crypto";

const secret = process.env.GITHUB_WEBHOOK_SECRET;
if (!secret || secret.length < 16) {
  throw new Error("GITHUB_WEBHOOK_SECRET must be configured in .env");
}

const mode = (process.argv[2] ?? "TEST").toUpperCase();
if (mode !== "TEST" && mode !== "FIX") {
  throw new Error("Usage: pnpm demo:trigger [TEST|FIX]");
}

const baseUrl = process.env.DEVSENTINEL_DEMO_URL ?? "http://127.0.0.1:3001";
const endpoint = new URL("/webhooks/github", baseUrl);
if (!["http:", "https:"].includes(endpoint.protocol)) {
  throw new Error("DEVSENTINEL_DEMO_URL must be an HTTP(S) origin");
}
if (!["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname)) {
  throw new Error("The demo webhook target is limited to loopback");
}

const now = new Date();
const command = [
  `/devsentinel ${mode.toLowerCase()}`,
  "Outcome: Demonstrate the complete authenticated local workflow",
  "Acceptance: The locked fixture test command produces recorded execution evidence",
  "Constraint: Do not broaden this demonstration beyond the configured fixture",
  "Scope: src",
].join("\n");
const payload = {
  action: "created",
  installation: { id: 1 },
  repository: { id: 1, full_name: "local/devsentinel-demo", default_branch: "main" },
  sender: { login: "local-demo-operator" },
  issue: {
    id: Math.floor(now.getTime() / 1000),
    number: Math.max(1, Number(process.env.DEVSENTINEL_DEMO_ISSUE ?? "1")),
    title: "Local DevSentinel evidence demo",
    body: "Exercise authorization, snapshot capture, sandbox execution, persistence, and the control center.",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  },
  comment: {
    id: now.getTime(),
    body: command,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  },
};
const body = JSON.stringify(payload);
const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-github-event": "issue_comment",
    "x-github-delivery": randomUUID(),
    "x-hub-signature-256": signature,
  },
  body,
  redirect: "error",
  signal: AbortSignal.timeout(10_000),
});
const result = await response.json().catch(() => ({ error: "Non-JSON response" }));
if (!response.ok) {
  throw new Error(`Demo webhook failed with HTTP ${response.status}: ${JSON.stringify(result)}`);
}
console.log(JSON.stringify(result, null, 2));
if (mode === "FIX") {
  console.log("FIX requires AGENT_ALLOWED_REPOSITORIES=local/devsentinel-demo and an enabled model; dry-run delivery is recommended first.");
}
