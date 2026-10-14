import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_ROOT_ENV = "PI_TEAMS_VITEST_ROOT";
const OPERATOR_HOME_ENV = "PI_TEAMS_VITEST_OPERATOR_HOME";

export default function setupTestHomes() {
  const previousRoot = process.env[TEST_ROOT_ENV];
  const previousOperatorHome = process.env[OPERATOR_HOME_ENV];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-vitest-"));

  process.env[TEST_ROOT_ENV] = root;
  process.env[OPERATOR_HOME_ENV] = os.homedir();

  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });

  return function teardownTestHomes() {
    cleanup();

    if (previousRoot === undefined) delete process.env[TEST_ROOT_ENV];
    else process.env[TEST_ROOT_ENV] = previousRoot;

    if (previousOperatorHome === undefined) delete process.env[OPERATOR_HOME_ENV];
    else process.env[OPERATOR_HOME_ENV] = previousOperatorHome;

  };
}
