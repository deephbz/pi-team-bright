import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

// Unit fixtures have one synthetic live process: the test process. Other PIDs
// need an explicit scenario probe. Restore/reset of spies must not expose the
// real OS verifier. Simulated actors supply their own HostEnv process table;
// native verifier tests invoke the native adapter directly.
vi.mock("../src/env/host-env", async importOriginal => {
  const module = await importOriginal<typeof import("../src/env/host-env")>();
  module.nodeHostEnv.process.generations = async pids => new Map(pids.map(pid => [pid, pid === process.pid
    ? { kind: "found", generation: { pid, osBirthToken: "fixture-birth", bootId: "fixture-boot" } }
    : { kind: "unknown", reason: "unit_fixture_unconfigured_pid" }]));
  return module;
});

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
const agentDir = path.join(home, ".pi", "agent");
fs.mkdirSync(agentDir, { recursive: true });
// Fixed-name fixtures opt out of calendar naming and never read operator settings.
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ pi_team_bright: { team: { date_prefix: false } } }));
delete process.env.PI_CODING_AGENT_DIR;
// A test runner can itself be a live Worker process. Do not let that outer
// Membership, launch capability, exact extension, or disposable aggregate
// become authority or mutable state inside an isolated fixture.
for (const key of [
  "PI_TEAM_NAME",
  "PI_AGENT_NAME",
  "PI_AGENT_LAUNCH_ID",
  "PI_TEAM_MEMBERSHIP_ID",
  "PI_TEAM_BRIGHT_SHIPPED_EXTENSION",
  "PI_TEAM_BRIGHT_WORKER_AGGREGATE",
  "PI_TEAMS_SESSION_ROOT",
  "PI_TEAMS_TRACE_JSONL",
  "PI_TEAMS_WORKER_STARTUP_WAIT_MS",
]) delete process.env[key];
// Synthetic extension lifecycle fixtures must never inherit production's 3s wait.
process.env.PI_TEAMS_WORKER_STARTUP_WAIT_MS = "0";
