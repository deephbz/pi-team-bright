import { beforeEach, expect, it, vi } from "vitest";
import { nodeHostEnv, runWithHostEnv } from "./env/host-env";
const f = vi.hoisted(() => ({ now: 1000, events: [] as any[], status: {} as any, member: {} as any, blocked: false, outage: false, beforeLease: undefined as undefined | (() => void) }));
vi.mock("node:fs", () => ({ default: { readFileSync: () => JSON.stringify({ terminalBackend: "herdr", members: [f.member] }) } }));
vi.mock("./utils/teams", () => ({ withCurrentMembershipLease: async (_: string, id: string, fn: any) => { f.beforeLease?.(); return fn(f.member); } }));
vi.mock("./utils/runtime", async importOriginal => ({ ...await importOriginal<any>(), readRuntimeStatus: async () => structuredClone(f.status) }));
vi.mock("./coordination/event-journal", () => ({
  readTeamEvents: (_: string, options: any) => ({ events: f.events.filter(e => Number(e.cursor) > Number(options.afterCursor)), cursor: String(f.events.length), truncated: false }),
  appendTeamEvent: async (_: string, event: any) => { const saved = { ...event, cursor: String(f.events.length + 1) }; f.events.push(saved); return saved; },
}));
import { CarrierObserver } from "./carrier-observation";
const env = () => ({ ...nodeHostEnv, clock: { ...nodeHostEnv.clock, now: () => f.now, setTimeout: (() => 0) as any, clearTimeout: () => {} }, process: { ...nodeHostEnv.process,
  generations: async (pids: readonly number[]) => new Map(pids.map(pid => [pid, { kind: "found" as const, generation: { pid, osBirthToken: "birth", bootId: "boot" } }])),
}, exec: { ...nodeHostEnv.exec, run: vi.fn(async (_: string, args: readonly string[]) => ({ kind: "exited" as const, status: 0, stderr: "", stdout: JSON.stringify(f.outage ? { error: "offline" } : { result: args[0] === "agent" ? { agents: [{ pane_id: "pane", name: "team-worker", agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: "/session" }, agent_status: f.blocked ? "blocked" : "idle" }] } : { panes: [{ pane_id: "pane" }] } }) })) } });
beforeEach(() => {
  f.now = 1000; f.events = []; f.blocked = false; f.outage = false; f.beforeLease = undefined;
  f.member = { name: "worker", agentType: "teammate", membershipId: "m", sessionFile: "/session", terminalTarget: { backend: "herdr", kind: "pane", targetId: "pane" } };
  f.status = { membershipId: "m", pid: 42, startedAt: 10, osBirthToken: "birth", bootId: "boot" };
});
const running = async () => { const observer = new CarrierObserver("team"); observer.start(); await observer.refresh(); return observer; };
it("keeps normal reload silent and reports a hung reload once", async () => runWithHostEnv(env(), async () => {
  const observer = await running();
  f.status.lastStop = { piReason: "reload", observedAt: f.now, suspectedHumanStop: false };
  await observer.refresh();
  delete f.status.lastStop; await observer.refresh();
  expect(f.events).toEqual([]);
  f.status.lastStop = { piReason: "reload", observedAt: f.now, suspectedHumanStop: false };
  await observer.refresh(); f.now += 16000; await observer.refresh(); await observer.refresh();
  expect(f.events).toHaveLength(1); expect(f.events[0].carrier).toMatchObject({ to: "stopping", nextActionHint: "ask_human" });
  observer.stop();
}));
it("journals blocked once until the next Worker Task event, including observer restart", async () => runWithHostEnv(env(), async () => {
  f.blocked = true;
  const observer = await running(); f.now += 4000; await observer.refresh(); await observer.refresh();
  expect(f.events.filter(e => e.carrier?.field === "blocked")).toHaveLength(1);
  observer.stop(); const restarted = await running(); f.now += 4000; await restarted.refresh();
  expect(f.events.filter(e => e.carrier?.field === "blocked")).toHaveLength(1);
  f.events.push({ type: "task", actor: "worker", cursor: String(f.events.length + 1) });
  await restarted.refresh(); f.now += 4000; await restarted.refresh();
  expect(f.events.filter(e => e.carrier?.field === "blocked")).toHaveLength(2); restarted.stop();
}));
it("discards a process observation after a successor admits", async () => runWithHostEnv(env(), async () => {
  f.status.osBirthToken = "dead";
  f.beforeLease = () => { f.status.osBirthToken = "birth"; f.status.startedAt = 20; };
  const observer = await running(); expect(f.events).toEqual([]); observer.stop();
}));
it("reports one attention per Herdr outage while process truth stays live", async () => runWithHostEnv(env(), async () => {
  f.outage = true; const observer = await running(); await observer.refresh();
  expect(f.events.filter(e => e.type === "alert")).toHaveLength(1);
  expect(observer.views.get("m")?.process).toBe("live");
  f.outage = false; await observer.refresh(); f.outage = true; await observer.refresh();
  expect(f.events.filter(e => e.type === "alert")).toHaveLength(2); observer.stop();
}));
it("does not journal diagnostic refreshes or repeat historical death", async () => runWithHostEnv(env(), async () => {
  f.status.osBirthToken = "dead";
  const diagnostic = new CarrierObserver("team"); await diagnostic.refresh(); expect(f.events).toEqual([]);
  const observer = await running(); expect(f.events).toHaveLength(1); observer.stop();
  const restarted = await running(); expect(f.events).toHaveLength(1); restarted.stop();
}));
