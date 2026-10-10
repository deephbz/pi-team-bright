import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ alive: true, time: 0, bound: false, mode: "exit", membershipId: "membership" }));
const isAlive = vi.hoisted(() => vi.fn((_paneId: string) => fixture.alive));
const readConfig = vi.hoisted(() => vi.fn(async () => ({ terminalBackend: "herdr", members: [] })));
const currentMembership = vi.hoisted(() => vi.fn(async () => ({ membershipId: fixture.membershipId, sessionFile: fixture.bound ? "session" : undefined,
  terminalTarget: { backend: "herdr", kind: "pane", targetId: "exact-pane" } })));
vi.mock("../utils/teams", () => ({ readConfig, currentMembership }));
vi.mock("../utils/team-terminal", () => ({ terminalForTeam: () => ({ name: "herdr", isAlive }) }));
vi.mock("../utils/runtime", () => ({
  readRuntimeStatus: async () => ({}),
  runtimeGeneration: () => ({ membershipId: "membership", pid: 42, startedAt: 100 }),
}));
vi.mock("../coordination/event-journal", () => ({
  waitForTeamEvents: async ({ waitMs }: { waitMs: number }) => {
    fixture.time += waitMs;
    if (fixture.mode === "exit") fixture.alive = false;
    if (fixture.mode === "bind" && fixture.time >= 750) {
      fixture.bound = true;
      return { cursor: "2", events: [{ type: "worker", worker: "worker", membershipId: "membership", phase: "session_bound",
        generation: { membershipId: "membership", pid: 42, startedAt: 100 } }], timedOut: false };
    }
    return { cursor: "1", events: [], timedOut: true };
  },
}));
import { DurableTeamLifecyclePublication } from "./durable-team-lifecycle-publication";

const input = { teamName: "team", workerName: "worker", membershipId: "membership", afterCursor: "0" };

describe("durable launch carrier observation", () => {
  beforeEach(() => {
    fixture.alive = true; fixture.time = 0; fixture.bound = false; fixture.mode = "exit"; fixture.membershipId = "membership";
    isAlive.mockReset().mockImplementation(() => fixture.alive);
    readConfig.mockReset().mockResolvedValue({ terminalBackend: "herdr", members: [] });
    currentMembership.mockClear();
    vi.stubEnv("PI_TEAMS_WORKER_STARTUP_WAIT_MS", "300000");
    vi.spyOn(performance, "now").mockImplementation(() => fixture.time);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("checks the exact terminal-adapter target and reports exit after one polling interval", async () => {
    const result = await new DurableTeamLifecyclePublication().observeWorkerStartup(input);
    expect(result).toMatchObject({ observed: false, reason: "carrier_gone" });
    expect(isAlive.mock.calls).toEqual([["exact-pane"], ["exact-pane"]]);
    expect(fixture.time).toBe(250);
  });

  it.each(["CLI timeout", "CLI nonzero status", "config read", "membership read"])("keeps observing after transient %s failure", async (source) => {
    fixture.mode = "bind";
    const error = new Error(source);
    if (source === "config read") readConfig.mockRejectedValueOnce(error);
    else if (source === "membership read") currentMembership.mockRejectedValueOnce(error);
    else isAlive.mockImplementationOnce(() => { throw error; });
    await expect(new DurableTeamLifecyclePublication().observeWorkerStartup(input)).resolves.toMatchObject({ observed: true });
    expect(fixture.time).toBe(750);
  });

  it("waits until the ceiling when every carrier probe is undecidable", async () => {
    fixture.mode = "hang";
    isAlive.mockImplementation(() => { throw new Error("CLI unavailable"); });
    await expect(new DurableTeamLifecyclePublication().observeWorkerStartup(input)).resolves.toMatchObject({ observed: false, reason: "timeout" });
    expect(fixture.time).toBe(300_000);
  });

  it("treats an explicitly replaced Membership as absence without probing its carrier", async () => {
    fixture.membershipId = "replacement";
    await expect(new DurableTeamLifecyclePublication().observeWorkerStartup(input)).resolves.toMatchObject({ observed: false, reason: "carrier_gone" });
    expect(isAlive).not.toHaveBeenCalled();
    expect(fixture.time).toBe(0);
  });
});
