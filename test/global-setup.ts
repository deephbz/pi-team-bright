import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_ROOT_ENV = "PI_TEAMS_VITEST_ROOT";
const OPERATOR_HOME_ENV = "PI_TEAMS_VITEST_OPERATOR_HOME";
const BEADS_TEST_ENV = {
  BD_DISABLE_EVENT_FLUSH: "1",
  BD_DISABLE_METRICS: "1",
} as const;

export default function setupTestHomes() {
  const previousRoot = process.env[TEST_ROOT_ENV];
  const previousOperatorHome = process.env[OPERATOR_HOME_ENV];
  const previousBeadsEnv = Object.fromEntries(
    Object.keys(BEADS_TEST_ENV).map((key) => [key, process.env[key]]),
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-vitest-"));

  process.env[TEST_ROOT_ENV] = root;
  process.env[OPERATOR_HOME_ENV] = os.homedir();
  Object.assign(process.env, BEADS_TEST_ENV);

  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  // Some Beads commands finish an event-store lock write while Vitest workers
  // are shutting down. Global teardown normally removes the suite root; this
  // final synchronous pass closes that narrow late-write race.
  process.once("exit", cleanup);

  return function teardownTestHomes() {
    cleanup();

    if (previousRoot === undefined) delete process.env[TEST_ROOT_ENV];
    else process.env[TEST_ROOT_ENV] = previousRoot;

    if (previousOperatorHome === undefined) delete process.env[OPERATOR_HOME_ENV];
    else process.env[OPERATOR_HOME_ENV] = previousOperatorHome;

    for (const key of Object.keys(BEADS_TEST_ENV)) {
      const previous = previousBeadsEnv[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  };
}
