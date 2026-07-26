import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    // The default TDD gate is in-process and fast. Real Beads/Dolt, lifecycle
    // contracts, end-to-end flows, and artifact generation remain explicit
    // package scripts backed by vitest.full.config.ts.
    exclude: [
      "**/node_modules/**",
      "**/*contract.test.ts",
      "**/*.external.test.ts",
      "**/*.e2e.test.ts",
      "src/utils/clean-cut-round2.test.ts",
      "scripts/snapshot-agent-surface.test.ts",
      "scripts/tool-result-qa/suite.test.ts",
    ],
  },
});
