import path from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  root: path.resolve(__dirname, ".."),
  test: { globalSetup: ["./test/global-setup.ts"], setupFiles: ["./test/setup.ts"],
    include: ["sim/attribution.campaign.ts"], testTimeout: 120000 },
});
