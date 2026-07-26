#!/usr/bin/env node
/* Materialize the owned Beads CLI when @beads/bd intentionally skips postinstall in CI. */
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION = "1.1.0";
const SHA256 = "b0f3dd607c3fb989ee08d0a6854fba80d0402971eb108f9af6170bc14d491a34";
const URL = `https://github.com/gastownhall/beads/releases/download/v${VERSION}/beads_${VERSION}_linux_amd64.tar.gz`;

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(`verified Beads materializer supports linux-x64 CI only, received ${process.platform}-${process.arch}`);
  }

  const manifestPath = require.resolve("@beads/bd/package.json");
  const manifest = require(manifestPath);
  if (manifest.version !== VERSION || manifest.bin?.bd !== "bin/bd.js") {
    throw new Error(`expected owned @beads/bd@${VERSION} launcher`);
  }
  const packageRoot = path.dirname(manifestPath);
  const launcher = path.join(packageRoot, manifest.bin.bd);
  const binary = path.join(packageRoot, "bin", "bd");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bright-beads-"));
  const archive = path.join(work, "beads.tar.gz");
  try {
    const response = await fetch(URL, { redirect: "follow" });
    if (!response.ok) throw new Error(`official Beads archive download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actual !== SHA256) throw new Error(`official Beads archive SHA-256 mismatch: expected ${SHA256}, received ${actual}`);
    fs.writeFileSync(archive, bytes, { mode: 0o600 });
    execFileSync("tar", ["--extract", "--gzip", "--file", archive, "--directory", path.dirname(binary), "bd"], { stdio: "inherit" });
    fs.chmodSync(binary, 0o755);
    const output = execFileSync(process.execPath, [launcher, "--version"], { encoding: "utf8" });
    if (!new RegExp(`^bd version ${VERSION.replaceAll(".", "\\.")}\\b`, "m").test(output)) {
      throw new Error(`owned Beads launcher reported an unexpected version: ${output.trim()}`);
    }
    process.stdout.write(output);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
