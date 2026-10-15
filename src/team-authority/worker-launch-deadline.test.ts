import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import * as teams from "../utils/teams";
import { configPath, teamDir } from "../utils/paths";
import { withLockDeadline } from "../utils/lock";
import { writeRuntimeStatus } from "../utils/runtime";
import { nodeHostEnv } from "../env/host-env";
import { HerdrAdapter } from "../adapters/herdr-adapter";
import { WorkerLaunchBridge } from "./worker-launch-bridge";
vi.mock("../utils/team-terminal", () => ({ currentTerminalForTeamAsync: async () => terminal }));
vi.mock("../utils/team-pane-placement", () => ({ teamPanePlacement: () => ({ leaderPaneId: "leader", workerPaneIds: [] }) }));
const terminal = new HerdrAdapter();
const created: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const name of created.splice(0)) fs.rmSync(teamDir(name), { recursive: true, force: true }); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture() {
  const name = `launch-deadline-${process.pid}-${created.length}-${Date.now()}`; created.push(name);
  const config = await teams.createTeam(name, "/fixture/lead.jsonl", "lead");
  teams.writeConfigAtomic(configPath(name), { ...config, terminalBackend: "herdr" });
  const bridge = new WorkerLaunchBridge({ buildWorkerArgv: () => ["pi"], workerAggregate: () => ({ projectTrusted: false }),
    lifecyclePublication: { readEventCursor: () => "0", recordWorkerPrepared: async () => ({ cursor: "1" }), observeWorkerStartup: vi.fn() } as any });
  return { name, bridge, request: { teamName: name, workerName: "worker", cwd: "/fixture", scope: "test", modelProfile: { provider: "fixture", model: "small" } } };
}
it("returns within ten seconds while the real Membership claim lease stays contended", async () => {
  const f = await fixture();
  await teams.addMember(f.name, { membershipId: "membership", name: "worker", agentId: "worker", agentType: "teammate", joinedAt: 1, cwd: "/fixture", subscriptions: [], sessionFile: "/fixture/worker.jsonl", isActive: true });
  await writeRuntimeStatus(f.name, "worker", { pid: process.pid, startedAt: 1, osBirthToken: "birth", bootId: "boot" }, "membership");
  vi.spyOn(nodeHostEnv.process, "generation").mockReturnValue({ kind: "found", generation: { pid: process.pid, osBirthToken: "birth", bootId: "boot" } });
  const acquired = deferred(); const release = deferred();
  const lease = teams.withMembershipMutationLease(f.name, "membership", async () => { acquired.resolve(); await release.promise; });
  await acquired.promise;
  const split = vi.spyOn(terminal, "prepareSpawnAsync"); const start = vi.spyOn(terminal, "startPrepared");
  vi.useFakeTimers(); const before = Date.now(); const receipt = f.bridge.ensureWorker(f.request);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await receipt).toMatchObject({ action: "attention", reason: "receipt_deadline", nextActionHint: "ask_human" });
  expect(Date.now() - before).toBe(10000);
  release.resolve(); await lease; await vi.advanceTimersByTimeAsync(100);
  expect(split).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
});
it.each([false, true])("bounds post-split target CAS and fences later reconciliation (successor=%s)", async successor => {
  const f = await fixture(); const release = deferred(); const acquired = deferred(); let lease!: Promise<void>;
  vi.spyOn(terminal, "prepareSpawnAsync").mockImplementation(async () => {
    const member = await teams.currentMembership(f.name, "worker");
    lease = withLockDeadline(Infinity, () => teams.withMembershipMutationLease(f.name, member.membershipId!, async () => {
      acquired.resolve(); await release.promise;
      if (successor) await teams.updateMembership(f.name, member.membershipId!, { launch: { launchId: "successor", state: "requested", requestedAt: Date.now() } });
    }));
    await acquired.promise; return "prepared-pane";
  });
  const start = vi.spyOn(terminal, "startPrepared");
  const completion = vi.spyOn(f.bridge, "completeLaunch");
  vi.useFakeTimers(); const receipt = f.bridge.ensureWorker(f.request);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await receipt).toMatchObject({ action: "attention", reason: "receipt_deadline", paneId: "prepared-pane", launch: "unknown" });
  release.resolve(); await lease; await vi.advanceTimersByTimeAsync(100);
  expect(completion).toHaveBeenCalledOnce();
  await Promise.all(completion.mock.results.map(result => result.value));
  const current = await teams.currentMembership(f.name, "worker");
  expect(start).not.toHaveBeenCalled();
  if (successor) { expect(current.launch?.launchId).toBe("successor"); expect(current.terminalTarget).toBeUndefined(); }
  else { expect(current.launch).toMatchObject({ state: "unknown", fact: "receipt_deadline_expired" }); expect(current.terminalTarget?.targetId).toBe("prepared-pane"); }
});
