import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ alive: true, time: 0, bound: false }));
const isAlive = vi.hoisted(() => vi.fn((_paneId: string) => fixture.alive));
vi.mock("../utils/teams", () => ({
  readConfig: async () => ({ terminalBackend: "herdr", members: [] }),
  currentMembership: async () => ({ membershipId: "membership", sessionFile: fixture.bound ? "session" : undefined,
    terminalTarget: { backend: "herdr", kind: "pane", targetId: "exact-pane" } }),
}));
vi.mock("../utils/team-terminal", () => ({ terminalForTeam: () => ({ name: "herdr", isAlive }) }));
vi.mock("../utils/runtime", () => ({
  readRuntimeStatus: async () => ({}),
  runtimeGeneration: () => ({ membershipId: "membership", pid: 42, startedAt: 100 }),
}));
vi.mock("../coordination/event-journal", () => ({
  waitForTeamEvents: async ({ waitMs }: { waitMs: number }) => {
    fixture.time += waitMs;
    fixture.alive = false;
    return { cursor: "1", events: [], timedOut: true };
  },
}));
import { DurableTeamLifecyclePublication } from "./durable-team-lifecycle-publication";

describe("durable launch carrier observation", () => {
  beforeEach(() => { fixture.alive = true; fixture.time = 0; fixture.bound = false; isAlive.mockClear(); vi.stubEnv("PI_TEAMS_WORKER_STARTUP_WAIT_MS", "300000"); });
  afterEach(() => vi.unstubAllEnvs());
  it("checks the exact terminal-adapter target and reports exit after one polling interval", async () => {
    const result = await new DurableTeamLifecyclePublication().observeWorkerStartup({
      teamName: "team", workerName: "worker", membershipId: "membership", afterCursor: "0",
    });
    expect(result).toMatchObject({ observed: false, reason: "carrier_gone" });
    expect(isAlive.mock.calls).toEqual([["exact-pane"], ["exact-pane"]]);
    expect(fixture.time).toBe(250);
  });
});
