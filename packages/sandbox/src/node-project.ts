import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type {
  NodeProjectPlan,
  SupportedPackageManager,
} from "./types.js";

export class UnsupportedNodeProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedNodeProjectError";
  }
}

const lockfiles = {
  npm: "package-lock.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
} as const satisfies Record<SupportedPackageManager, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

async function readWorkspaceFile(
  workspacePath: string,
  filename: string,
): Promise<string> {
  const workspaceRealPath = await realpath(workspacePath);
  const filePath = resolve(workspaceRealPath, filename);

  if (!(await isRegularFile(filePath))) {
    throw new UnsupportedNodeProjectError(
      `${filename} must be a regular file at the repository root`,
    );
  }

  const fileRealPath = await realpath(filePath);
  const workspacePrefix = workspaceRealPath.endsWith(sep)
    ? workspaceRealPath
    : `${workspaceRealPath}${sep}`;

  if (!fileRealPath.startsWith(workspacePrefix)) {
    throw new UnsupportedNodeProjectError(
      `${filename} resolves outside the repository workspace`,
    );
  }

  return readFile(fileRealPath, "utf8");
}

function parsePackageManager(
  value: unknown,
): { name: SupportedPackageManager; version: string } | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^(npm|pnpm|yarn)@([^+\s]+)(?:\+.+)?$/.exec(value);

  if (!match?.[1] || !match[2]) {
    throw new UnsupportedNodeProjectError(
      "packageManager must pin npm, pnpm, or yarn to a version",
    );
  }

  return {
    name: match[1] as SupportedPackageManager,
    version: match[2],
  };
}

function commandsFor(
  manager: SupportedPackageManager,
  version: string | null,
): Pick<NodeProjectPlan, "installCommand" | "testCommand"> {
  if (manager === "npm") {
    return {
      installCommand: [
        "npm",
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      testCommand: ["npm", "test"],
    };
  }

  if (!version) {
    throw new UnsupportedNodeProjectError(
      `${manager} repositories must declare a pinned packageManager in package.json`,
    );
  }

  if (manager === "pnpm") {
    return {
      installCommand: [
        "corepack",
        "pnpm",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
      ],
      testCommand: ["corepack", "pnpm", "test"],
    };
  }

  const majorVersion = Number.parseInt(version.split(".")[0] ?? "", 10);
  return {
    installCommand:
      Number.isFinite(majorVersion) && majorVersion >= 2
        ? ["corepack", "yarn", "install", "--immutable", "--mode=skip-builds"]
        : [
            "corepack",
            "yarn",
            "install",
            "--frozen-lockfile",
            "--ignore-scripts",
          ],
    testCommand: ["corepack", "yarn", "test"],
  };
}

export async function detectNodeProject(
  workspacePath: string,
): Promise<NodeProjectPlan> {
  let parsedPackage: unknown;

  try {
    parsedPackage = JSON.parse(
      await readWorkspaceFile(workspacePath, "package.json"),
    );
  } catch (error) {
    if (error instanceof UnsupportedNodeProjectError) {
      throw error;
    }

    throw new UnsupportedNodeProjectError("package.json is not valid JSON");
  }

  if (!isRecord(parsedPackage)) {
    throw new UnsupportedNodeProjectError(
      "package.json must contain a JSON object",
    );
  }

  if (
    !isRecord(parsedPackage.scripts) ||
    typeof parsedPackage.scripts.test !== "string" ||
    parsedPackage.scripts.test.trim().length === 0
  ) {
    throw new UnsupportedNodeProjectError(
      "package.json must define a non-empty test script",
    );
  }

  const presentLockfiles: SupportedPackageManager[] = [];

  for (const [manager, filename] of Object.entries(lockfiles) as Array<
    [SupportedPackageManager, string]
  >) {
    if (await isRegularFile(resolve(workspacePath, filename))) {
      presentLockfiles.push(manager);
    }
  }

  if (presentLockfiles.length !== 1) {
    throw new UnsupportedNodeProjectError(
      presentLockfiles.length === 0
        ? "A supported lockfile is required: package-lock.json, pnpm-lock.yaml, or yarn.lock"
        : `Exactly one supported lockfile is required; found ${presentLockfiles.join(", ")}`,
    );
  }

  const manager = presentLockfiles[0];

  if (!manager) {
    throw new UnsupportedNodeProjectError("Could not identify a package manager");
  }

  const declaredManager = parsePackageManager(parsedPackage.packageManager);

  if (declaredManager && declaredManager.name !== manager) {
    throw new UnsupportedNodeProjectError(
      `packageManager declares ${declaredManager.name}, but the repository contains ${lockfiles[manager]}`,
    );
  }

  const packageManagerVersion = declaredManager?.version ?? null;

  return {
    packageManager: manager,
    packageManagerVersion,
    ...commandsFor(manager, packageManagerVersion),
  };
}
