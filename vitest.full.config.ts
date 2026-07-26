import { defineConfig } from "vitest/config";

/** Explicit exhaustive lane; the default config deliberately keeps local TDD fast. */
export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
