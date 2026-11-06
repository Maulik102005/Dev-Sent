import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.evaluation.test.ts"],
    fileParallelism: false,
  },
});
