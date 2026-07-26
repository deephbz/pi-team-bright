import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
const lanes = JSON.parse(readFileSync(new URL("./test-lanes.json", import.meta.url), "utf8"));
export default defineConfig({ test: { globalSetup: ["./test/global-setup.ts"], setupFiles: ["./test/setup.ts"], include: lanes.exhaustiveOnly } });
