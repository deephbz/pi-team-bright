import fs from "node:fs";
import path from "node:path";

const root = process.env.PI_TEAMS_VITEST_ROOT;
if (!root) {
  throw new Error("PI_TEAMS_VITEST_ROOT is missing; Vitest global setup did not run");
}

// Vitest executes setup files before loading each test file. Include both the
// process and pool identity so this remains worker-local for fork and thread
// pools, while repeated setup in one worker resolves to the same HOME.
const workerIdentity = [
  process.pid,
  process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "main",
].join("-").replace(/[^a-zA-Z0-9_-]/g, "_");
const home = path.join(root, `worker-${workerIdentity}`);

fs.mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PI_TEAMS_VITEST_HOME = home;
for (const key of ["PI_TEAM_NAME", "PI_AGENT_NAME", "PI_AGENT_LAUNCH_ID", "PI_TEAMS_SESSION_ROOT", "PI_TEAMS_TRACE_JSONL", "PI_TEAMS_WORKER_STARTUP_WAIT_MS"]) delete process.env[key];
