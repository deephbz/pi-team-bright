import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

// Regression for the independent C2 native probe; no production process is changed.
it.skipIf(process.platform !== "darwin")("reports stable microsecond birth identity and decisive absence on macOS", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-native-probe-"));
  try {
    const helper = path.join(dir, "generation");
    const build = spawnSync("rustc", ["native/process-generation.rs", "-o", helper], { encoding: "utf8", timeout: 30000 });
    expect(build.status, build.stderr).toBe(0);
    const read = () => {
      const result = spawnSync(helper, [String(process.pid), "2147483647"], { encoding: "utf8", timeout: 2000 });
      expect(result.status).toBe(0);
      return result.stdout.trim().split("\n");
    };
    const first = read(); const second = read();
    expect(first[0]).toMatch(new RegExp(`^${process.pid} found \\d+:\\d{1,6} \\d+:\\d+$`));
    expect(second[0]).toBe(first[0]);
    expect(first[1]).toBe("2147483647 absent");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
