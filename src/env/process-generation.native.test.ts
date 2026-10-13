import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

// Host integration: requires macOS, rustc and Xcode Command Line Tools.
// Builds in a temporary package layout; never needs a preinstalled native/bin.
// Invokes the native adapter directly, outside the unit HostEnv verifier fixture.
it.skipIf(process.platform !== "darwin")("builds via the macOS postinstall hook and reports stable birth identity and absence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-native-probe-"));
  try {
    // A clean installed layout has source and the build script, but no binary.
    for (const file of ["package.json", "native/process-generation.rs", "scripts/build-process-generation.sh"]) {
      const target = path.join(dir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target);
    }
    const helper = path.join(dir, "native/bin/process-generation");
    expect(fs.existsSync(helper)).toBe(false);
    const build = spawnSync("npm", ["run", "postinstall"], { cwd: dir, encoding: "utf8", timeout: 30000 });
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
