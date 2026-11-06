import {
  beginRunBaselining,
  beginRunProvisioning,
  completeRunBaseline,
  findRunForBaseline,
  sealTaskBriefSnapshot,
  type Database,
} from "@devsentinel/database";
import type { RunStatus } from "@devsentinel/domain";
import type { BaselineJobData } from "@devsentinel/queue";
import {
  detectNodeProject,
  type BaselineSandbox,
} from "@devsentinel/sandbox";

import type { RepositorySource } from "./repository-source.js";
import { loadRepositoryGuidance } from "./repository-guidance.js";

export type ProcessBaselineResult =
  | { outcome: "completed"; status: RunStatus; reason: string }
  | { outcome: "already-processed"; status: RunStatus };

const resumableStatuses: readonly RunStatus[] = [
  "PREPARING",
  "PROVISIONING",
  "BASELINING",
];

export async function processBaselineJob(
  db: Database,
  repositorySource: RepositorySource,
  sandbox: BaselineSandbox,
  data: BaselineJobData,
): Promise<ProcessBaselineResult> {
  let run = await findRunForBaseline(db, data.runId);

  if (!run) {
    throw new Error(`Run ${data.runId} does not exist`);
  }

  if (run.mode !== data.mode) {
    throw new Error(
      `Run mode mismatch for ${data.runId}: job=${data.mode}, database=${run.mode}`,
    );
  }

  if (!resumableStatuses.includes(run.status)) {
    return { outcome: "already-processed", status: run.status };
  }

  const snapshot = await repositorySource.materialize({
    githubInstallationId: run.githubInstallationId,
    githubRepositoryId: run.githubRepositoryId,
    repositoryFullName: run.repositoryFullName,
    ref: run.targetCommitSha ?? run.defaultBranch,
  });

  try {
    if (run.targetCommitSha && run.targetCommitSha !== snapshot.commitSha) {
      throw new Error(
        `Repository snapshot changed during retry: expected ${run.targetCommitSha}, received ${snapshot.commitSha}`,
      );
    }

    const plan = await detectNodeProject(snapshot.path);
    const guidance = await loadRepositoryGuidance(snapshot.path);

    await sealTaskBriefSnapshot(db, {
      runId: run.id,
      commitSha: snapshot.commitSha,
      guidance: {
        path: guidance.path,
        hash: guidance.hash,
        version: guidance.version,
        content: guidance.content,
        config: guidance.config,
      },
    });

    if (run.status === "PREPARING") {
      await beginRunProvisioning(db, {
        runId: run.id,
        commitSha: snapshot.commitSha,
        packageManager: plan.packageManager,
      });
      run = await findRunForBaseline(db, run.id);

      if (!run) {
        throw new Error(`Run ${data.runId} disappeared during preparation`);
      }
    }

    if (!resumableStatuses.includes(run.status)) {
      return { outcome: "already-processed", status: run.status };
    }

    if (
      run.targetCommitSha !== snapshot.commitSha ||
      run.detectedPackageManager !== plan.packageManager
    ) {
      throw new Error("Persisted repository snapshot metadata does not match preparation");
    }

    if (run.status === "PROVISIONING") {
      await beginRunBaselining(db, run.id);
      run = await findRunForBaseline(db, run.id);

      if (!run) {
        throw new Error(`Run ${data.runId} disappeared during provisioning`);
      }
    }

    if (run.status !== "BASELINING") {
      return { outcome: "already-processed", status: run.status };
    }

    const result = await sandbox.executeBaseline({
      runId: run.id,
      workspacePath: snapshot.path,
      plan,
    });
    const completed = await completeRunBaseline(db, {
      runId: run.id,
      mode: run.mode,
      result,
    });

    if (completed) {
      return { outcome: "completed", ...completed };
    }

    const latest = await findRunForBaseline(db, run.id);

    if (!latest) {
      throw new Error(`Run ${data.runId} disappeared after baseline execution`);
    }

    return { outcome: "already-processed", status: latest.status };
  } finally {
    await snapshot.cleanup();
  }
}
