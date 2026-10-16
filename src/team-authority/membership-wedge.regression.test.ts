import { writeJsonFixture } from "../utils/test-write-json";
import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import * as teams from "../utils/teams";
import { configPath, teamDir } from "../utils/paths";
import { HerdrAdapter } from "../adapters/herdr-adapter";
import type { Member } from "./contracts";
import { TeamLifecycleService } from "./team-lifecycle-service";
import { WorkerLaunchBridge } from "./worker-launch-bridge";

/**
 * Regressions for the 2026-10-16 wedge: each refused spawn left a target-less
 * prepared Membership that blocked every later spawn and that no tool could stop.
 */
vi.mock("../utils/team-terminal", () => ({
  currentTerminalForTeam: async () => terminal,
  terminalForTeam: async () => terminal,
  assertTargetSupportedByTerminal: () => undefined,
}));
const terminal = new HerdrAdapter();
const GEOMETRY = "Insufficient Herdr pane geometry for another Worker";
const created: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const name of created.splice(0)) fs.rmSync(teamDir(name), { recursive: true, force: true }); });

async function fixture(extra: Member[] = []) {
  const name = `membership-wedge-${process.pid}-${created.length}-${Date.now()}`; created.push(name);
  const config = await teams.createTeam(name, "/fixture/lead.jsonl", "lead");
  const members = config.members.map(m => m.agentType === "lead" ? { ...m, terminalTarget: { backend: "herdr" as const, kind: "pane" as const, targetId: "leader" } } : m);
  writeJsonFixture(configPath(name), { ...config, terminalBackend: "herdr", members: [...members, ...extra] });
  const bridge = new WorkerLaunchBridge({ buildWorkerArgv: () => ["pi"], workerAggregate: () => ({ projectTrusted: false }),
    lifecyclePublication: { readEventCursor: () => "0", recordWorkerPrepared: async () => ({ cursor: "1" }), observeWorkerStartup: vi.fn() } as any });
  const lifecycle = new TeamLifecycleService({
    assignedWorkGuard: { nonterminalTaskIds: async () => [], nonterminalTaskIdsAssignedToWorker: async () => [] } as any,
    lifecyclePublication: { readEventCursor: () => "0", recordWorkerPrepared: async () => ({ cursor: "1" }), recordWorkerStopped: async () => ({ cursor: "1" }) } as any,
  });
  const request = (workerName: string) => ({ teamName: name, workerName, cwd: "/fixture", scope: "test", modelProfile: { provider: "fixture", model: "small" } });
  return { name, bridge, lifecycle, request };
}
const worker = (name: string, fields: Partial<Member>): Member => ({ membershipId: `${name}-membership`, name, agentId: `${name}@t`, agentType: "teammate", joinedAt: 1, cwd: "/fixture", subscriptions: [], isActive: true, ...fields });
const teammates = async (team: string) => (await teams.readConfig(team)).members.filter(m => m.agentType === "teammate");

it("writes nothing when placement refuses a new Worker", async () => {
  const f = await fixture([worker("old", { sessionFile: "/fixture/old.jsonl" })]);
  const before = await teammates(f.name);
  await expect(f.bridge.ensureWorker(f.request("worker"))).rejects.toThrow(/old has no exact herdr pane target/);
  expect(await teammates(f.name)).toEqual(before);
});

it("refuses a launch that failed before Herdr started Pi, then stops it and spawns past it", async () => {
  const f = await fixture();
  vi.spyOn(terminal, "prepareSpawn").mockRejectedValueOnce(new Error(GEOMETRY));
  const start = vi.spyOn(terminal, "startPrepared").mockResolvedValue({ state: "started", fact: "carrier_start_accepted" });
  await expect(f.bridge.ensureWorker(f.request("worker"))).rejects.toThrow(GEOMETRY);
  expect(start).not.toHaveBeenCalled();
  const refused = await teams.currentMembership(f.name, "worker");
  expect(refused.launch).toMatchObject({ state: "refused", fact: `not_actuated: ${GEOMETRY}` });
  expect(refused.terminalTarget).toBeUndefined();

  // The target-less prepared Membership owns no pane, so another Worker can still be placed.
  const prepare = vi.spyOn(terminal, "prepareSpawn").mockResolvedValue("other-pane");
  expect(await f.bridge.ensureWorker(f.request("other"))).toMatchObject({ action: "created" });
  expect(prepare.mock.calls[0]![0].panePlacement).toMatchObject({ leaderPaneId: "leader", workerPaneIds: [] });

  // It owns no process either, so stop deactivates it without a terminal kill.
  const kill = vi.spyOn(terminal, "kill");
  expect(await f.lifecycle.stopWorker(f.name, "worker")).toEqual({ kind: "stopped", worker: "worker" });
  expect(kill).not.toHaveBeenCalled();
  expect((await teams.readConfig(f.name)).members.find(m => m.name === "worker")).toMatchObject({ isActive: false });
});

it("keeps a pre-rc.1 target-less prepared record fail-closed", async () => {
  const f = await fixture([worker("worker", { pendingLaunchId: "L1" })]);
  expect(await f.lifecycle.stopWorker(f.name, "worker")).toMatchObject({ kind: "refused", reason: "stop_not_confirmed" });
  expect(await teams.currentMembership(f.name, "worker")).toMatchObject({ isActive: true, pendingLaunchId: "L1" });
});
