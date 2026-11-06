import type { RecordedBaselineResult } from "@devsentinel/database";
import type { NodeProjectPlan } from "@devsentinel/sandbox";

import { safeRepositoryPath, type RepositoryAgentConfig } from "./repository-guidance.js";

export function executionPassed(result: RecordedBaselineResult | null | undefined): boolean {
  return Boolean(result && result.install.exitCode === 0 && !result.install.timedOut && result.test?.exitCode === 0 && !result.test.timedOut);
}

export function failureSignatures(result: RecordedBaselineResult | null | undefined): string[] {
  if (!result?.test) return [];
  const lines = `${result.test.stdout}\n${result.test.stderr}`.split(/\r?\n/);
  const signatures = lines.flatMap((line) => {
    const trimmed = line.trim().replace(/\x1b\[[0-9;]*m/g, "");
    const match = /^(?:not ok\s+\d+\s*-\s*|FAIL\s+|×\s+|✗\s+|failed:\s*)(.+)$/i.exec(trimmed);
    return match?.[1] ? [match[1].replace(/\s+/g, " ").slice(0, 500)] : [];
  });
  return [...new Set(signatures)].slice(0, 200);
}

function keywords(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [])]
    .filter((token) => !["the", "and", "for", "with", "from", "test", "issue", "should"].includes(token));
}

export function chooseTestProfile(config: RepositoryAgentConfig, task: string) {
  const taskTokens = keywords(task);
  const scored = config.testProfiles.map((profile) => {
    const profileText = `${profile.name} ${profile.relevantPaths.join(" ")}`.toLowerCase();
    const score = taskTokens.reduce((sum, token) => sum + (profileText.includes(token) ? 1 : 0), 0);
    return { profile, score };
  }).sort((left, right) => right.score - left.score || left.profile.name.localeCompare(right.profile.name));
  return scored[0] && scored[0].score > 0 ? scored[0].profile : null;
}

export function planForTestProfile(plan: NodeProjectPlan, paths: string[]): NodeProjectPlan {
  if (paths.length === 0 || paths.length > 30 || paths.some((path) => !safeRepositoryPath(path))) throw new Error("Unsafe targeted test profile");
  return {
    ...plan,
    testCommand: [...plan.testCommand, "--", ...paths],
  };
}

export function assessVerification(input: {
  criteria: string[];
  baseline: RecordedBaselineResult | null | undefined;
  targeted: RecordedBaselineResult | null;
  candidate: RecordedBaselineResult;
  profileName: string | null;
  taskText: string;
  regressionBaseline?: RecordedBaselineResult | null;
}) {
  const baselineFailures = failureSignatures(input.baseline);
  const candidateFailures = failureSignatures(input.candidate);
  const relevance = keywords(`${input.taskText} ${input.profileName ?? ""}`);
  const relevantBaseline = input.profileName
    ? baselineFailures.filter((failure) => relevance.some((token) => failure.toLowerCase().includes(token)))
    : baselineFailures;
  const unrelatedBaseline = baselineFailures.filter((failure) => !relevantBaseline.includes(failure));
  const newFailures = candidateFailures.filter((failure) => !baselineFailures.includes(failure));
  const targetedPassed = input.targeted ? executionPassed(input.targeted) : executionPassed(input.candidate);
  const fullSuitePassed = executionPassed(input.candidate);
  const acceptanceSupported = targetedPassed && newFailures.length === 0 &&
    (baselineFailures.length > 0 || input.baseline?.test?.exitCode !== 0 || Boolean(input.profileName) ||
      Boolean(input.regressionBaseline && !executionPassed(input.regressionBaseline)));
  const acceptanceEvidence = input.criteria.map((criterion) => ({
    criterion,
    status: acceptanceSupported ? "SUPPORTED" as const : "UNVERIFIED" as const,
    evidenceReferences: acceptanceSupported
      ? [
          ...(input.profileName ? [`targeted-test:${input.profileName}`] : []),
          ...(input.regressionBaseline ? ["regression-original-failure"] : []),
          "baseline-test",
          "candidate-full-suite",
        ]
      : ["candidate-full-suite"],
  }));
  const deliveryEligible = acceptanceSupported && fullSuitePassed && unrelatedBaseline.length === 0;
  return {
    baselineFailures,
    candidateFailures,
    unrelatedBaseline,
    newFailures,
    targetedPassed,
    fullSuitePassed,
    acceptanceEvidence,
    acceptanceCriteriaVerified: acceptanceEvidence.length > 0 && acceptanceEvidence.every((item) => item.status === "SUPPORTED"),
    requiredChecksPassed: targetedPassed && newFailures.length === 0 && fullSuitePassed,
    deliveryEligible,
  };
}
