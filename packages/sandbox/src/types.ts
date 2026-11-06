export type SupportedPackageManager = "npm" | "pnpm" | "yarn";

export interface NodeProjectPlan {
  packageManager: SupportedPackageManager;
  packageManagerVersion: string | null;
  installCommand: readonly string[];
  testCommand: readonly string[];
}

export interface SandboxCommandResult {
  command: readonly string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface BaselineExecutionResult {
  image: string;
  install: SandboxCommandResult;
  test: SandboxCommandResult | null;
}

export interface BaselineExecutionRequest {
  runId: string;
  workspacePath: string;
  plan: NodeProjectPlan;
  signal?: AbortSignal;
  deadlineMs?: number;
}

export interface BaselineSandbox {
  executeBaseline(
    request: BaselineExecutionRequest,
  ): Promise<BaselineExecutionResult>;
}
