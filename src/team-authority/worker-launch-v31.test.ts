import { beforeEach, expect, it, vi } from "vitest";
import type { Member } from "./contracts";
const fixture = vi.hoisted(() => ({ members: [] as Member[], leased: false, starts: 0, splits: 0, release: undefined as undefined | ((value: any) => void) }));
vi.mock("../utils/lock", () => ({ withLock: async (_: unknown, fn: () => unknown) => fn() }));
vi.mock("../utils/teams", () => ({
  readConfig: async () => ({ name: "team", terminalBackend: "herdr", members: fixture.members }),
  newLaunchId: () => `launch-${fixture.members.length + 1}`,
  newMembershipId: () => "membership",
  addMember: async (_: unknown, member: Member) => { fixture.members.push(member); },
  withCurrentMembershipLease: async (_: unknown, id: string, fn: (member: Member) => unknown) => {
    fixture.leased = true;
    try { return await fn(fixture.members.find(m => m.membershipId === id)!); } finally { fixture.leased = false; }
  },
  updateMembership: async (_: unknown, id: string, updates: Partial<Member>) => Object.assign(fixture.members.find(m => m.membershipId === id)!, updates),
}));
vi.mock("../utils/team-pane-placement", () => ({ teamPanePlacement: () => ({ leaderPaneId: "leader", workerPaneIds: [] }) }));
vi.mock("../utils/team-terminal", async () => {
  const { HerdrAdapter } = await import("../adapters/herdr-adapter.js");
  const terminal = new HerdrAdapter();
  terminal.prepareSpawn = () => { expect(fixture.leased).toBe(false); fixture.splits++; return "pane"; };
  terminal.startPrepared = () => {
    expect(fixture.leased).toBe(false);
    expect(fixture.members[0].terminalTarget?.targetId).toBe("pane");
    fixture.starts++;
    return new Promise(resolve => { fixture.release = resolve; });
  };
  return { currentTerminalForTeam: () => terminal };
});
import { WorkerLaunchBridge } from "./worker-launch-bridge";

beforeEach(() => { fixture.members = []; fixture.leased = false; fixture.splits = 0; fixture.starts = 0; });
it("returns a durable receipt before readiness and fences late completion", async () => {
  const publication = { readEventCursor: () => "0", recordWorkerPrepared: async () => ({ cursor: "1" }), observeWorkerStartup: vi.fn() } as any;
  const bridge = new WorkerLaunchBridge({ buildWorkerArgv: () => ["pi"], workerAggregate: () => ({ projectTrusted: false }), lifecyclePublication: publication });
  const request = { teamName: "team", workerName: "worker", cwd: "/workspace", scope: "test", modelProfile: { provider: "fixture", model: "small" } };
  const first = await bridge.ensureWorker(request);
  expect(first).toMatchObject({ action: "created", launchId: "launch-1", launch: "requested" });
  const second = await bridge.ensureWorker(request);
  expect(second).toMatchObject({ action: "attention", launchId: "launch-1", reason: "launch_pending" });
  expect(fixture.splits).toBe(1);
  expect(fixture.starts).toBe(1);
  expect(publication.observeWorkerStartup).not.toHaveBeenCalled();
  fixture.members[0].launch!.launchId = "successor";
  fixture.release!({ state: "refused", fact: "late reply" });
  await Promise.resolve(); await Promise.resolve();
  expect(fixture.members[0].launch).toMatchObject({ launchId: "successor", state: "requested" });
});
