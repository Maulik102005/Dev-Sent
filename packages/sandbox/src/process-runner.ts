import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface ProcessRunRequest {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  outputLimitBytes: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ProcessRunResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface ProcessRunner {
  run(request: ProcessRunRequest): Promise<ProcessRunResult>;
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  truncated = false;

  constructor(private readonly limitBytes: number) {}

  append(chunk: Buffer): void {
    const remaining = this.limitBytes - this.capturedBytes;

    if (remaining <= 0) {
      this.truncated = true;
      return;
    }

    if (chunk.byteLength > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.capturedBytes += remaining;
      this.truncated = true;
      return;
    }

    this.chunks.push(chunk);
    this.capturedBytes += chunk.byteLength;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export class SpawnProcessRunner implements ProcessRunner {
  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    request.signal?.throwIfAborted();
    if (request.timeoutMs < 1) {
      throw new Error("Process timeout must be positive");
    }

    if (request.outputLimitBytes < 1) {
      throw new Error("Process output limit must be positive");
    }

    const startedAt = performance.now();
    const stdout = new BoundedOutput(request.outputLimitBytes);
    const stderr = new BoundedOutput(request.outputLimitBytes);

    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let timedOut = false;
      let settled = false;
      const cancel = () => { child.kill("SIGKILL"); };
      request.signal?.addEventListener("abort", cancel, { once: true });
      if (request.signal?.aborted) cancel();
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, request.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));

      child.once("error", (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", cancel);
        reject(error);
      });

      child.once("close", (exitCode) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", cancel);
        resolve({
          exitCode,
          timedOut,
          durationMs: Math.round(performance.now() - startedAt),
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          outputTruncated: stdout.truncated || stderr.truncated,
        });
      });
    });
  }
}
