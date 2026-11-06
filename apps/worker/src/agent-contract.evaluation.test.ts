import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { validateProposal, type SourceFile } from "./repair-policy.js";
import { assessVerification } from "./verification-policy.js";

const command = (exitCode: number, stdout = "") => ({ command: ["npm", "test"], exitCode, timedOut: false, durationMs: 10, stdout, stderr: "", outputTruncated: false });
const execution = (exitCode: number, stdout = "") => ({ image: "node:eval", install: command(0), test: command(exitCode, stdout) });
const source: SourceFile[] = [{ path: "src/total.js", content: "export const total = (price, quantity) => price + quantity;\n", editable: true }];

describe("deterministic agent evaluation", () => {
  it("reports resolution, scope, verification, latency, usage, and failure-classification signals", () => {
    const started = performance.now();
    const valid = validateProposal({ summary: "Multiply unit price by quantity", edits: [{ path: "src/total.js", content: "export const total = (price, quantity) => price * quantity;\n" }] }, source);
    const resolved = assessVerification({
      criteria: ["three items cost three unit prices"],
      baseline: execution(1, "not ok 1 - quantity total"),
      targeted: execution(0), candidate: execution(0), profileName: "quantity", taskText: "quantity total",
    });
    let scopeViolationBlocked = false;
    try { validateProposal({ summary: "Weaken CI", edits: [{ path: ".github/workflows/ci.yml", content: "disabled" }] }, source); }
    catch { scopeViolationBlocked = true; }
    const unrelated = assessVerification({
      criteria: ["quantity behavior is corrected"],
      baseline: execution(1, "not ok 1 - quantity total\nnot ok 2 - shipping threshold"),
      targeted: execution(0), candidate: execution(1, "not ok 2 - shipping threshold"), profileName: "quantity", taskText: "quantity total",
    });
    const missingReproducer = assessVerification({
      criteria: ["uncaptured boundary is fixed"], baseline: execution(0), targeted: null, candidate: execution(0), profileName: null, taskText: "uncaptured boundary",
    });
    const report = {
      suite: "mock-provider/offline",
      cases: 4,
      issueResolutionRate: resolved.deliveryEligible ? 1 : 0,
      scopeViolationBlockRate: scopeViolationBlocked ? 1 : 0,
      verificationQuality: { supportedFromExecution: resolved.acceptanceCriteriaVerified, unsupportedWithoutReproducer: !missingReproducer.acceptanceCriteriaVerified },
      failureClassifications: {
        resolved: resolved.deliveryEligible ? "DELIVERY_ELIGIBLE" : "UNSUCCESSFUL_PATCH",
        unrelated: unrelated.acceptanceCriteriaVerified && !unrelated.deliveryEligible ? "VERIFIED_UNDELIVERED" : "UNSUCCESSFUL_PATCH",
        missingReproducer: missingReproducer.acceptanceCriteriaVerified ? "DELIVERY_ELIGIBLE" : "UNREPRODUCED_BUG",
      },
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, sourceEdits: valid.edits.length },
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
    };
    expect(report).toMatchObject({
      suite: "mock-provider/offline", cases: 4, issueResolutionRate: 1, scopeViolationBlockRate: 1,
      verificationQuality: { supportedFromExecution: true, unsupportedWithoutReproducer: true },
      failureClassifications: { resolved: "DELIVERY_ELIGIBLE", unrelated: "VERIFIED_UNDELIVERED", missingReproducer: "UNREPRODUCED_BUG" },
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, sourceEdits: 1 },
    });
    console.log(`DEVSENTINEL_EVALUATION ${JSON.stringify(report)}`);
  });
});
