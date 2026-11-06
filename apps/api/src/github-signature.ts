import { createHmac, timingSafeEqual } from "node:crypto";

const signaturePrefix = "sha256=";

export function signGitHubPayload(payload: Buffer, secret: string): string {
  return `${signaturePrefix}${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

export function verifyGitHubSignature(
  payload: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature?.startsWith(signaturePrefix)) {
    return false;
  }

  const expected = Buffer.from(signGitHubPayload(payload, secret), "utf8");
  const received = Buffer.from(signature, "utf8");

  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}
