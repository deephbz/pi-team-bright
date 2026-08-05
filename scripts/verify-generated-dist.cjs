#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");

// The accepted rc.6 source bundle retains this generated declaration delta
// until the release commit records it. Reject every other tracked delta.
const FROZEN_GENERATED_DIST_DIFF_SHA256 = "e79bde408aaab1afefba67f57a7ff77af6d35719c591ca5e3132e4c96be02a17";
const FROZEN_GENERATED_DIST_SUPPORT_FILES = new Set([
  "dist/model-tool-contract/task-version-ref.d.ts",
  "dist/model-tool-contract/task-version-ref.js",
]);

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

try {
  const generatedDiff = git(["diff", "--binary", "--", "dist"], { capture: true });
  if (generatedDiff.length > 0) {
    const digest = createHash("sha256").update(generatedDiff).digest("hex");
    if (digest !== FROZEN_GENERATED_DIST_DIFF_SHA256) {
      console.error(`generated dist differs from the frozen baseline: ${digest}`);
      process.exitCode = 1;
      process.exit();
    }
    console.log(`generated dist matches frozen baseline: ${digest}`);
  }
  const unexpected = git(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--", "dist"],
    { capture: true },
  )
    .trim()
    .split("\n")
    .filter((file) => file && !FROZEN_GENERATED_DIST_SUPPORT_FILES.has(file));
  if (unexpected.length > 0) {
    console.error(`generated dist contains untracked files:\n${unexpected.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("generated dist matches tracked files");
  }
} catch (error) {
  process.exitCode = typeof error.status === "number" ? error.status : 1;
}
