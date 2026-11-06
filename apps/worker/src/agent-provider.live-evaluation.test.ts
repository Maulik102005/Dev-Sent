import { describe, expect, it } from "vitest";

import { OpenAIRepairModel } from "./repair-model.js";

const enabled = process.env.DEVSENTINEL_ENABLE_PAID_EVALS === "1";

describe.skipIf(!enabled)("opt-in paid live provider evaluation", () => {
  it("obtains a bounded safe escalation from the configured live model", async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL;
    if (!apiKey || !model) throw new Error("OPENAI_API_KEY and OPENAI_MODEL are required for the explicitly enabled paid evaluation");
    const response = await new OpenAIRepairModel({ apiKey, model, maxOutputTokens: 512, maxModelTurns: 1 }).propose({
      issue: "The request contains no reproduction details. Escalate without changing source.",
      files: [], failure: "No execution failure was recorded.", previous: null,
    }, AbortSignal.timeout(90_000));
    expect(response.proposal.edits).toEqual([]);
    expect(response.inputTokens + response.outputTokens).toBeGreaterThan(0);
  });
});
