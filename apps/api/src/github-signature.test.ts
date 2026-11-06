import { describe, expect, it } from "vitest";

import { signGitHubPayload, verifyGitHubSignature } from "./github-signature.js";

describe("GitHub webhook signatures", () => {
  const payload = Buffer.from('{"action":"labeled"}');
  const secret = "a-development-secret";

  it("accepts the matching HMAC-SHA256 signature", () => {
    const signature = signGitHubPayload(payload, secret);

    expect(verifyGitHubSignature(payload, signature, secret)).toBe(true);
  });

  it("rejects a modified signature", () => {
    const signature = `${signGitHubPayload(payload, secret).slice(0, -1)}0`;

    expect(verifyGitHubSignature(payload, signature, secret)).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifyGitHubSignature(payload, undefined, secret)).toBe(false);
  });
});
