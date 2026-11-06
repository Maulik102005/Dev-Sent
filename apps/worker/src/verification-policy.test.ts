import { describe, expect, it } from "vitest";
import { assessVerification, chooseTestProfile, planForTestProfile } from "./verification-policy.js";

const command = (exitCode: number, stdout = "") => ({ command: ["npm", "test"], exitCode, timedOut: false, durationMs: 1, stdout, stderr: "", outputTruncated: false });
const result = (exitCode: number, stdout = "") => ({ image: "node", install: command(0), test: command(exitCode, stdout) });
const config = {
  version: 1 as const,
  guidance: { path: "DEVSENTINEL.md", version: "1" },
  supportedSourcePaths: ["src"], excludedPaths: [],
  testProfiles: [
    { name: "discount", relevantPaths: ["test/discount.test.js"], runner: "package-test" as const },
    { name: "shipping", relevantPaths: ["test/shipping.test.js"], runner: "package-test" as const },
  ],
  regressionTests: { enabled: false, allowedPaths: ["test"] },
};

describe("verification policy", () => {
  it("chooses only an application-approved profile and constructs arguments without a shell", () => {
    const profile = chooseTestProfile(config, "discount is wrong at ten items");
    expect(profile?.name).toBe("discount");
    expect(planForTestProfile({ packageManager: "npm", packageManagerVersion: null, installCommand: ["npm", "ci"], testCommand: ["npm", "test"] }, profile!.relevantPaths).testCommand)
      .toEqual(["npm", "test", "--", "test/discount.test.js"]);
    expect(() => planForTestProfile({ packageManager: "npm", packageManagerVersion: null, installCommand: [], testCommand: [] }, ["../escape"])).toThrow();
  });

  it("uses execution evidence and blocks delivery for unrelated baseline failures", () => {
    const assessment = assessVerification({
      criteria: ["discount is correct"],
      baseline: result(1, "not ok 1 - discount boundary\nnot ok 2 - shipping threshold"),
      targeted: result(0),
      candidate: result(1, "not ok 2 - shipping threshold"),
      profileName: "discount",
      taskText: "discount boundary",
    });
    expect(assessment.acceptanceCriteriaVerified).toBe(true);
    expect(assessment.unrelatedBaseline).toEqual(["shipping threshold"]);
    expect(assessment.deliveryEligible).toBe(false);
  });

  it("never treats a model statement as acceptance evidence", () => {
    const assessment = assessVerification({ criteria: ["fixed because the AI says so"], baseline: result(0), targeted: null, candidate: result(0), profileName: null, taskText: "AI says fixed" });
    expect(assessment.acceptanceCriteriaVerified).toBe(false);
    expect(assessment.acceptanceEvidence[0]?.status).toBe("UNVERIFIED");
  });

  it("supports a green-baseline fix only when a frozen reproducer fails before and passes after", () => {
    const assessment = assessVerification({
      criteria: ["the reported boundary is covered"],
      baseline: result(0),
      regressionBaseline: result(1, "not ok 1 - reported boundary"),
      targeted: result(0),
      candidate: result(0),
      profileName: "regression:test/boundary.test.js",
      taskText: "reported boundary",
    });
    expect(assessment.acceptanceCriteriaVerified).toBe(true);
    expect(assessment.acceptanceEvidence[0]?.evidenceReferences).toContain("regression-original-failure");
    expect(assessment.deliveryEligible).toBe(true);
  });
});
