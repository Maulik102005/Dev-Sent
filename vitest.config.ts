import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/*.integration.test.ts",
      "**/*.browser.test.ts",
      "**/*.evaluation.test.ts",
      "**/*.live-evaluation.test.ts",
      "fixtures/**",
    ],
  },
});
