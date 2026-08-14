#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv.length !== 0 && (argv.length !== 2 || argv[0] !== "--samples" || !/^\d+$/.test(argv[1] ?? ""))) {
  throw new Error("Usage: node scripts/ensure-worker-tool-benchmark.mjs [--samples N]");
}
const samples = argv.length === 0 ? 5 : Number(argv[1]);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100) {
  throw new Error("--samples must be an integer from 1 through 100.");
}

const root = mkdtempSync(path.join(os.tmpdir(), "pi-team-ensure-worker-benchmark-run-"));
const output = path.join(root, "result.json");
const environment = {
  ...process.env,
  PI_TEAMS_ENSURE_WORKER_BENCHMARK_OUTPUT: output,
  PI_TEAMS_ENSURE_WORKER_BENCHMARK_SAMPLES: String(samples),
};
delete environment.PI_TEAM_MEMBERSHIP_ID;

try {
  const result = spawnSync("npx", ["vitest", "run", "scripts/ensure-worker-tool-benchmark.test.ts"], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Benchmark test failed:\n${result.stderr || result.stdout}`);
  }
  process.stdout.write(readFileSync(output, "utf8"));
} finally {
  rmSync(root, { recursive: true, force: true });
}
