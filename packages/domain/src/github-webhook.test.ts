import { describe, expect, it } from "vitest";

import { extractRunContinuation, extractRunTrigger, parseCommandContext } from "./github-webhook.js";

const basePayload = {
  installation: { id: 901 },
  repository: {
    id: 501,
    full_name: "octocat/hello-world",
    default_branch: "main",
  },
  sender: { login: "maintainer" },
  issue: { number: 42 },
};

describe("extractRunTrigger", () => {
  it("accepts the explicit issue label", () => {
    expect(
      extractRunTrigger("issues", {
        ...basePayload,
        action: "labeled",
        label: { name: "devsentinel:fix" },
      }),
    ).toMatchObject({
      issueNumber: 42,
      activation: "label",
      mode: "FIX",
    });
  });

  it("accepts the test label", () => {
    expect(
      extractRunTrigger("issues", {
        ...basePayload,
        action: "labeled",
        label: { name: "devsentinel:test" },
      }),
    ).toMatchObject({
      issueNumber: 42,
      activation: "label",
      mode: "TEST",
    });
  });

  it.each([
    ["/devsentinel fix this parser bug", "FIX"],
    ["/devsentinel test", "TEST"],
    ["/DEVSENTINEL TEST on node 22", "TEST"],
  ])("accepts the slash command %s", (body, mode) => {
    expect(
      extractRunTrigger("issue_comment", {
        ...basePayload,
        action: "created",
        comment: { body },
      }),
    ).toMatchObject({
      issueNumber: 42,
      activation: "command",
      mode,
    });
  });

  it("does not accept a command prefix that changes the operation name", () => {
    expect(
      extractRunTrigger("issue_comment", {
        ...basePayload,
        action: "created",
        comment: { body: "/devsentinel fix-this" },
      }),
    ).toBeNull();
  });

  it("ignores unrelated labels", () => {
    expect(
      extractRunTrigger("issues", {
        ...basePayload,
        action: "labeled",
        label: { name: "bug" },
      }),
    ).toBeNull();
  });

  it("does not treat pull-request comments as issue triggers", () => {
    expect(
      extractRunTrigger("issue_comment", {
        ...basePayload,
        action: "created",
        issue: { number: 42, pull_request: { url: "https://example.test" } },
        comment: { body: "/devsentinel fix" },
      }),
    ).toBeNull();
  });

  it("captures the complete command context and bounded structured scope", () => {
    expect(parseCommandContext(`/devsentinel fix checkout boundary\nAcceptance: ten items receive the discount\nScope: src/checkout.js\nExclude: src/generated\nConstraint: preserve cents`)).toEqual({
      raw: "checkout boundary\nAcceptance: ten items receive the discount\nScope: src/checkout.js\nExclude: src/generated\nConstraint: preserve cents",
      requestedOutcome: "checkout boundary",
      acceptanceCriteria: ["ten items receive the discount"],
      approvedPaths: ["src/checkout.js"],
      excludedPaths: ["src/generated"],
      constraints: ["preserve cents"],
    });
  });

  it("accepts only an explicit continuation with run id, answer, issue, and actor provenance", () => {
    const runId = "7502d27c-475c-4ae3-8e14-df3eab430943";
    expect(extractRunContinuation("issue_comment", {
      ...basePayload,
      action: "created",
      comment: { id: 88, created_at: "2026-09-10T00:00:00Z", body: `/devsentinel continue ${runId}\nUse the ten-item boundary.` },
    })).toMatchObject({ runId, answer: "Use the ten-item boundary.", actorLogin: "maintainer", deliveryCommentId: "88" });
    expect(extractRunContinuation("issue_comment", { ...basePayload, action: "created", comment: { body: "/devsentinel continue explain more" } })).toBeNull();
  });
});
