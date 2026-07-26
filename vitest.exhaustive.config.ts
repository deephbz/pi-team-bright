import { defineConfig } from "vitest/config";
export default defineConfig({ test: { globalSetup: ["./test/global-setup.ts"], setupFiles: ["./test/setup.ts"], include: ["**/*contract.test.ts", "**/*.external.test.ts", "**/*.e2e.test.ts", "src/utils/clean-cut-round2.test.ts", "scripts/snapshot-agent-surface.test.ts", "scripts/tool-result-qa/suite.test.ts"] } });
