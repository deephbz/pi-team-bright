#!/usr/bin/env node
const { execFileSync } = require("node:child_process");

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

try {
  git(["diff", "--exit-code", "--", "dist"]);
  const unexpected = git(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--", "dist"],
    { capture: true },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (unexpected.length > 0) {
    console.error(`generated dist contains untracked files:\n${unexpected.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("generated dist matches tracked files");
  }
} catch (error) {
  process.exitCode = typeof error.status === "number" ? error.status : 1;
}
