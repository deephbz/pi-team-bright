import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("renders the standalone palette without Pi runtime import conditions", () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [
    require.resolve("ts-node/dist/bin.js"), "--transpile-only",
    path.resolve("src/cli/ptb-palette-gallery.ts"), "--plain", "--tab", "Team",
  ], { env, encoding: "utf8", timeout: 15000 });
  expect(result.stderr).not.toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Automatic sync");
  expect(result.stdout).toContain("Worker pane layout");
});
