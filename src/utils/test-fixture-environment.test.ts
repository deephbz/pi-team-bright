import { expect, it } from "vitest";

it("uses an isolated deterministic PiTeams fixture environment", () => {
  expect(process.env.PI_TEAMS_WORKER_STARTUP_WAIT_MS).toBe("0");
  expect(process.env.HOME).toBe(process.env.PI_TEAMS_VITEST_HOME);
  expect(process.env.HOME).toContain(process.env.PI_TEAMS_VITEST_ROOT!);
  for (const key of ["PI_TEAM_NAME", "PI_AGENT_NAME", "PI_AGENT_LAUNCH_ID", "PI_TEAMS_SESSION_ROOT", "PI_TEAMS_TRACE_JSONL"]) expect(process.env[key]).toBeUndefined();
});
