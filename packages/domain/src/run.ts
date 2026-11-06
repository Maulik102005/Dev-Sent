export const runModeValues = ["TEST", "FIX"] as const;

export type RunMode = (typeof runModeValues)[number];

export const runStatusValues = [
  "AUTHORIZING",
  "PREPARING",
  "PROVISIONING",
  "BASELINING",
  "DIAGNOSING",
  "PATCHING",
  "VERIFYING",
  "AWAITING_CLARIFICATION",
  "PUBLISHING",
  "SUCCEEDED",
  "NEEDS_HUMAN",
  "BUDGET_EXHAUSTED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
] as const;

export const runFailureClassificationValues = [
  "UNCLEAR_TASK",
  "UNREPRODUCED_BUG",
  "BASELINE_TEST_FAILURE",
  "POLICY_BLOCKED",
  "UNSUCCESSFUL_PATCH",
  "BUDGET_EXHAUSTED",
  "PERMANENT_CONFIGURATION",
  "TRANSIENT_INFRASTRUCTURE",
  "CANCELLED",
  "VERIFIED_UNDELIVERED",
] as const;

export type RunFailureClassification =
  (typeof runFailureClassificationValues)[number];

export type RunStatus = (typeof runStatusValues)[number];

export const terminalRunStatusValues = [
  "SUCCEEDED",
  "NEEDS_HUMAN",
  "BUDGET_EXHAUSTED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
] as const satisfies readonly RunStatus[];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return terminalRunStatusValues.includes(
    status as (typeof terminalRunStatusValues)[number],
  );
}
