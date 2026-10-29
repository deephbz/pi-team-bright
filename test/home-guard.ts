import fs from "node:fs";
import os from "node:os";

// A test process may write only below its worker HOME. Bun caches os.homedir() at start, so a HOME set at
// runtime does not reach it; on 2026-10-29 a Bun test run wrote the operator's ~/.pi/teams this way.
// os.userInfo().homedir names the operator HOME independently of the HOME variable under Node.
export function proveIsolatedHome(home: string): void {
  const resolved = fs.realpathSync(os.homedir());
  const operator = fs.realpathSync(os.userInfo().homedir);
  if (resolved !== fs.realpathSync(home) || resolved === operator) {
    throw new Error(`HOME isolation failed: os.homedir() is ${resolved}, HOME is ${home}, the operator HOME is ${operator}. This runtime does not follow a HOME set at runtime; run the tests under Node. No test code ran.`);
  }
}
