import type { RunMode } from "@devsentinel/domain";

export interface AuthorizationTarget {
  runId: string;
  mode: RunMode;
  githubInstallationId: number;
  githubRepositoryId: number;
  repositoryFullName: string;
  issueNumber: number;
  actorLogin: string;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reason: string;
}

export interface RunAuthorizer {
  authorize(target: AuthorizationTarget): Promise<AuthorizationDecision>;
}

export const githubBasePermissionValues = [
  "none",
  "read",
  "write",
  "admin",
] as const;

export type GitHubBasePermission =
  (typeof githubBasePermissionValues)[number];

export interface AuthorizationPermissionPolicy {
  TEST: Exclude<GitHubBasePermission, "none">;
  FIX: Exclude<GitHubBasePermission, "none">;
}

const permissionRank: Record<GitHubBasePermission, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

export function permissionMeetsMinimum(
  actual: GitHubBasePermission,
  required: Exclude<GitHubBasePermission, "none">,
): boolean {
  return permissionRank[actual] >= permissionRank[required];
}

export class DevelopmentAllowAllAuthorizer implements RunAuthorizer {
  async authorize(_target: AuthorizationTarget): Promise<AuthorizationDecision> {
    return {
      allowed: true,
      reason:
        "Allowed by explicit development-allow-all mode; no GitHub permission check was performed",
    };
  }
}
