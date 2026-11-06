import {
  completeRunAuthorization,
  findRunForAuthorization,
  type Database,
} from "@devsentinel/database";
import type { RunStatus } from "@devsentinel/domain";
import type { AuthorizationJobData } from "@devsentinel/queue";

import type { RunAuthorizer } from "./authorization.js";

export type ProcessAuthorizationResult =
  | { outcome: "authorized"; status: "PREPARING" }
  | { outcome: "rejected"; status: "REJECTED" }
  | { outcome: "already-processed"; status: RunStatus };

export async function processAuthorizationJob(
  db: Database,
  authorizer: RunAuthorizer,
  data: AuthorizationJobData,
): Promise<ProcessAuthorizationResult> {
  const run = await findRunForAuthorization(db, data.runId);

  if (!run) {
    throw new Error(`Run ${data.runId} does not exist`);
  }

  if (run.mode !== data.mode) {
    throw new Error(
      `Run mode mismatch for ${data.runId}: job=${data.mode}, database=${run.mode}`,
    );
  }

  if (run.status !== "AUTHORIZING") {
    return { outcome: "already-processed", status: run.status };
  }

  const decision = await authorizer.authorize({
    runId: run.id,
    mode: run.mode,
    githubInstallationId: run.githubInstallationId,
    githubRepositoryId: run.githubRepositoryId,
    repositoryFullName: run.repositoryFullName,
    issueNumber: run.issueNumber,
    actorLogin: run.actorLogin,
  });
  const updated = await completeRunAuthorization(db, {
    runId: run.id,
    allowed: decision.allowed,
    reason: decision.reason,
  });

  if (updated) {
    return decision.allowed
      ? { outcome: "authorized", status: "PREPARING" }
      : { outcome: "rejected", status: "REJECTED" };
  }

  const latest = await findRunForAuthorization(db, data.runId);

  if (!latest) {
    throw new Error(`Run ${data.runId} disappeared during authorization`);
  }

  return { outcome: "already-processed", status: latest.status };
}
