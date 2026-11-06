import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { AgentToolSession } from "./agent-tools.js";
import { ModelCallError, modelInput, OpenAIRepairModel } from "./repair-model.js";
const request = { issue: "broken", files: [], failure: "assertion", previous: null };
const completed = {
  id: "resp_test", status: "completed",
  output: [{ content: [{ type: "output_text", text: JSON.stringify({ summary: "Cannot safely fix", edits: [] }) }] }],
  usage: { input_tokens: 5, output_tokens: 10 },
};
function gateway(response: Response) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  const model = new OpenAIRepairModel({ apiKey: "test-key", model: "configured-model", maxOutputTokens: 1024, fetchImplementation: fetcher });
  return { model, fetcher };
}
async function failure(model: OpenAIRepairModel, signal = new AbortController().signal): Promise<ModelCallError> {
  try { await model.propose(request, signal); }
  catch (error) { expect(error).toBeInstanceOf(ModelCallError); return error as ModelCallError; }
  throw new Error("Expected model failure");
}
describe("model gateway", () => {
  it("secret-filters every model-input layer, including structured task and clarification fields", () => {
    const secret = "sk-123456789012345678901234";
    const input = modelInput({
      issue: `broken ${secret}`,
      files: [{ path: "src/a.js", content: `export const token = "${secret}";`, editable: false }],
      failure: `authorization: Bearer ${secret}`,
      previous: { summary: secret, edits: [{ path: "src/a.js", content: secret }] },
      taskBrief: { requestedOutcome: secret, constraints: [secret] },
      repositoryGuidance: { version: "1", hash: "a".repeat(64), content: secret },
      clarifications: [{ question: secret, answer: secret }],
      discussion: [{ reference: "issue-comment:1", author: "owner", createdAt: "2026-09-10T00:00:00Z", body: secret }],
    });
    expect(input).not.toContain(secret);
    expect(input).toContain("[REDACTED TOKEN]");
  });
  it("executes bounded application tools across turns and requires a saved plan before a patch", async () => {
    const session = new AgentToolSession({
      root: resolve("fixtures/sandbox/repair-node"),
      config: { version: 1, guidance: { path: "DEVSENTINEL.md", version: "1" }, supportedSourcePaths: ["src"], excludedPaths: [], testProfiles: [], regressionTests: { enabled: false, allowedPaths: ["test"] } },
      approvedPaths: [], excludedPaths: [], allowRegressionTests: false,
      budget: { maxCalls: 4, maxOutputBytes: 8_000, deadlineMs: Date.now() + 10_000 },
    });
    const plan = { suspectedCause: "Quantity is added", evidenceReferences: ["src/total.js:1"], intendedFiles: ["src/total.js"], scopeExclusions: ["tests"], verificationSteps: ["Run the package test suite"] };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "turn-1", status: "completed", output: [{ type: "function_call", call_id: "call-plan", name: "submit_plan", arguments: JSON.stringify(plan) }], usage: { input_tokens: 10, output_tokens: 4 } }))
      .mockResolvedValueOnce(Response.json({ id: "turn-2", status: "completed", output: [{ type: "function_call", call_id: "call-patch", name: "propose_patch", arguments: JSON.stringify({ summary: "Multiply by quantity", edits: [{ path: "src/total.js", content: "export function total(price, quantity) { return price * quantity; }\n" }] }) }], usage: { input_tokens: 12, output_tokens: 6 } }));
    const model = new OpenAIRepairModel({ apiKey: "test", model: "configured", maxOutputTokens: 1024, maxModelTurns: 2, fetchImplementation: fetcher });
    const response = await model.propose({ ...request, tools: session }, new AbortController().signal);
    expect(response).toMatchObject({ plan, inputTokens: 22, outputTokens: 10, proposal: { edits: [{ path: "src/total.js" }] } });
    expect(response.toolTrace?.map((item) => item.tool)).toEqual(["submit_plan", "propose_patch"]);
    const firstBody = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(firstBody).toMatchObject({ tool_choice: "required", parallel_tool_calls: false });
    expect(firstBody.tools[0]).toMatchObject({ type: "function", strict: false });
    expect(firstBody.tools.map((tool: { name: string }) => tool.name)).toContain("submit_plan");
    const secondBody = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(Array.isArray(secondBody.input)).toBe(true);
    expect(secondBody.tools.map((tool: { name: string }) => tool.name)).not.toContain("submit_plan");
    expect(secondBody.tools.map((tool: { name: string }) => tool.name)).toContain("propose_patch");
  });
  it("requests strict structured output without remote response storage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify({ summary: "Cannot safely fix", edits: [] }) }] }], usage: { input_tokens: 5, output_tokens: 10 } }));
    const model = new OpenAIRepairModel({ apiKey: "test-key", model: "configured-model", maxOutputTokens: 1024, fetchImplementation: fetcher });
    expect(await model.propose(request, new AbortController().signal)).toMatchObject({ inputTokens: 5, outputTokens: 10 });
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ model: "configured-model", store: false, max_output_tokens: 1024, text: { format: { strict: true, type: "json_schema" } } });
    expect(body).not.toHaveProperty("tools");
  });
  it("preserves successful response metadata", async () => {
    const { model, fetcher } = gateway(Response.json(completed, { headers: { "x-request-id": "req_test" } }));
    expect(await model.propose(request, new AbortController().signal)).toMatchObject({ inputTokens: 5, outputTokens: 10,
      diagnostics: { kind: "completed", responseId: "resp_test", requestId: "req_test", httpStatus: 200, retryable: false } });
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("preserves incomplete reason and usage instead of labelling it a refusal", async () => {
    const { model } = gateway(Response.json({ ...completed, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }));
    expect(await failure(model)).toMatchObject({ inputTokens: 5, outputTokens: 10,
      diagnostics: { kind: "incomplete", reason: "max_output_tokens", status: "incomplete", retryable: false } });
  });
  it("recognizes a refusal in a completed response without retaining its free text", async () => {
    const { model } = gateway(Response.json({ ...completed, output: [{ content: [{ type: "refusal", refusal: "private source and api_key=sk-12345678901234567890" }] }] }));
    const error = await failure(model);
    expect(error).toMatchObject({ inputTokens: 5, outputTokens: 10, diagnostics: { kind: "refused", retryable: false, reason: "provider_refusal" } });
    expect(JSON.stringify(error)).not.toContain("private source");
    expect(JSON.stringify(error)).not.toContain("sk-");
  });
  it.each([
    [401, "invalid_api_key", false], [400, "invalid_request_error", false],
    [429, "insufficient_quota", false], [429, "rate_limit_exceeded", true], [503, "server_error", true],
  ] as const)("classifies HTTP %s / %s and retains only safe metadata", async (status, code, retryable) => {
    const { model } = gateway(Response.json({ error: { code, message: "private-provider-message" } }, { status, headers: { "x-request-id": "req_failure" } }));
    const error = await failure(model);
    expect(error).toMatchObject({ inputTokens: null, outputTokens: null,
      diagnostics: { kind: "api_error", httpStatus: status, reason: code, requestId: "req_failure", retryable } });
    expect(JSON.stringify(error) + error.message).not.toContain("private-provider-message");
  });
  it("recognizes failed responses and their available usage", async () => {
    const error = await failure(gateway(Response.json({ ...completed, status: "failed", error: { code: "server_error" } })).model);
    expect(error).toMatchObject({ inputTokens: 5, outputTokens: 10, diagnostics: { kind: "api_error", reason: "server_error", retryable: true } });
  });
  it("retains usage when completed output is not a valid proposal", async () => {
    const error = await failure(gateway(Response.json({ ...completed, output: [{ content: [{ type: "output_text", text: "private code, not JSON" }] }] })).model);
    expect(error).toMatchObject({ inputTokens: 5, outputTokens: 10, diagnostics: { kind: "invalid_response", reason: "invalid_proposal" } });
    expect(error.message).not.toContain("private code");
  });
  it("keeps missing usage unknown and known zero usage intact", async () => {
    const error = await failure(gateway(Response.json({ ...completed, usage: { input_tokens: 0 } })).model);
    expect(error).toMatchObject({ inputTokens: 0, outputTokens: null, diagnostics: { reason: "usage_missing_or_invalid" } });
    const result = await gateway(Response.json({ ...completed, usage: { input_tokens: 0, output_tokens: 0 } })).model.propose(request, new AbortController().signal);
    expect(result).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
  it.each([-1, 0.5, 2147483648, "5"])("rejects invalid usage %s", async (input_tokens) => {
    const error = await failure(gateway(Response.json({ ...completed, usage: { input_tokens, output_tokens: 10 } })).model);
    expect(error).toMatchObject({ inputTokens: null, outputTokens: 10, diagnostics: { reason: "usage_missing_or_invalid" } });
  });
  it("bounds successful response bodies before parsing", async () => {
    const error = await failure(gateway(new Response("x".repeat(512001))).model);
    expect(error.diagnostics).toMatchObject({ kind: "invalid_response", reason: "response_too_large" });
  });
  it("does not include invalid JSON or secret-looking IDs in diagnostics", async () => {
    const invalid = await failure(gateway(new Response("private source text")).model);
    expect(invalid.message).not.toContain("private source text");
    const error = await failure(gateway(Response.json({ status: "failed", id: "sk-12345678901234567890", error: { code: "api_key=secret" } }, { headers: { "x-request-id": "sk-12345678901234567890" } })).model);
    expect(error.diagnostics).toMatchObject({ responseId: null, requestId: null, reason: "provider_failed" });
  });
  it.each(["TimeoutError", "AbortError"])("distinguishes %s without issuing a request", async (name) => {
    const { model, fetcher } = gateway(Response.json(completed));
    const error = await failure(model, AbortSignal.abort(new DOMException("private abort details", name)));
    expect(error.diagnostics).toMatchObject({ kind: name === "TimeoutError" ? "timeout" : "cancelled", retryable: name === "TimeoutError" });
    expect(error.message).not.toContain("private abort details");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sanitizes transport failures with unknown usage", async () => {
    const model = new OpenAIRepairModel({ apiKey: "test", model: "configured", maxOutputTokens: 1024,
      fetchImplementation: vi.fn<typeof fetch>().mockRejectedValue(new TypeError("private request details")) });
    const error = await failure(model);
    expect(error).toMatchObject({ inputTokens: null, outputTokens: null, diagnostics: { kind: "network_error", retryable: true } });
    expect(error.message).not.toContain("private request details");
  });
  it("does not leak error response bodies", async () => {
    const model = new OpenAIRepairModel({ apiKey: "test", model: "configured", maxOutputTokens: 1024, fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive provider details", { status: 401 })) });
    const error = await failure(model);
    expect(error.diagnostics).toMatchObject({ kind: "api_error", httpStatus: 401, reason: "unreadable_error_body", retryable: false });
    expect(error.message).not.toContain("sensitive provider details");
  });
});
