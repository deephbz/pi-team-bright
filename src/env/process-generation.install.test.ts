import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("installs without rustc with one macOS helper build warning and exit zero", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-install-no-rustc-"));
  try {
    const scripts = path.join(root, "scripts");
    const bin = path.join(root, "fixture-bin");
    fs.mkdirSync(scripts);
    fs.mkdirSync(bin);
    const script = path.join(scripts, "build-process-generation.sh");
    fs.copyFileSync("scripts/build-process-generation.sh", script);
    // The script sees Darwin but cannot find rustc or any host PATH fallback.
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Darwin\\n'\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "dirname"), '#!/bin/sh\nprintf "%s\\n" "${1%/*}"\n', { mode: 0o755 });
    const result = spawnSync("/bin/sh", [script], { cwd: root, env: { ...process.env, PATH: bin }, encoding: "utf8", timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(/warning.*rustc.*missing/i);
    expect(result.stderr).toContain("npm run build:process-generation");
    expect(fs.existsSync(path.join(root, "native/bin"))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
