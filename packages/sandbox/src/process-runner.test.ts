import { describe, expect, it } from "vitest";

import { SpawnProcessRunner } from "./process-runner.js";

describe("SpawnProcessRunner", () => {
  it("drains process output while storing only the configured limit", async () => {
    const runner = new SpawnProcessRunner();
    const execution = await runner.run({
      executable: "/usr/bin/printf",
      args: ["%s", "x".repeat(10_000)],
      timeoutMs: 2_000,
      outputLimitBytes: 128,
    });

    expect(execution.exitCode).toBe(0);
    expect(Buffer.byteLength(execution.stdout)).toBe(128);
    expect(execution.outputTruncated).toBe(true);
  });

  it("kills and reports a command that exceeds its wall-clock budget", async () => {
    const runner = new SpawnProcessRunner();
    const execution = await runner.run({
      executable: "/usr/bin/sleep",
      args: ["5"],
      timeoutMs: 50,
      outputLimitBytes: 128,
    });

    expect(execution.timedOut).toBe(true);
    expect(execution.exitCode).toBeNull();
    expect(execution.durationMs).toBeLessThan(2_000);
  });
});
