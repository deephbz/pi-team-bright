import { beforeEach, expect, it, vi } from "vitest";
import { nodeHostEnv, runWithHostEnv } from "./env/host-env";
const f = vi.hoisted(() => ({ now: 1000, events: [] as any[], status: {} as any, member: {} as any, blocked: false, outage: false, noAgent: false, paneId: "pane", panePresent: true, configFailure: false, journalFailure: false, appendFailures: 0, leaseFailures: 0, beforeLease: undefined as undefined | (() => void) }));
vi.mock("node:fs", () => ({ default: { readFileSync: () => { if (f.configFailure) throw new Error("config unavailable"); return JSON.stringify({ terminalBackend: "herdr", members: [f.member] }); } } }));
vi.mock("./utils/teams", () => ({ withCurrentMembershipLease: async (_: string, id: string, fn: any) => { if (f.leaseFailures > 0) { f.leaseFailures--; throw new Error("lease unavailable"); } f.beforeLease?.(); return fn(f.member); } }));
vi.mock("./utils/runtime", async importOriginal => ({ ...await importOriginal<any>(), readRuntimeStatus: async () => structuredClone(f.status) }));
vi.mock("./coordination/event-journal", () => ({
  readTeamEvents: (_: string, options: any) => { if (f.journalFailure) throw new Error("journal unavailable"); return { events: f.events.filter(e => Number(e.cursor) > Number(options.afterCursor)), cursor: String(f.events.length), truncated: false }; },
  appendTeamEvent: async (_: string, event: any) => { if (f.appendFailures > 0) { f.appendFailures--; throw new Error("EIO"); } const saved = { ...event, cursor: String(f.events.length + 1) }; f.events.push(saved); return saved; },
}));
import { CarrierObserver } from "./carrier-observation";
const env = () => ({ ...nodeHostEnv, clock: { ...nodeHostEnv.clock, now: () => f.now, setTimeout: (() => 0) as any, clearTimeout: () => {} }, process: { ...nodeHostEnv.process,
  generations: async (pids: readonly number[]) => new Map(pids.map(pid => [pid, { kind: "found" as const, generation: { pid, osBirthToken: "birth", bootId: "boot" } }])),
}, exec: { ...nodeHostEnv.exec, run: vi.fn(async (_: string, args: readonly string[]) => ({ kind: "exited" as const, status: 0, stderr: "", stdout: JSON.stringify(f.outage ? { error: "offline" } : { result: args[0] === "agent" ? { agents: f.noAgent ? [] : [{ pane_id: "pane", name: "team-worker", agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: "/session" }, agent_status: f.blocked ? "blocked" : "idle" }] } : { panes: f.panePresent ? [{ pane_id: f.paneId }] : [] } }) })) } });
beforeEach(() => {
  f.now = 1000; f.events = []; f.noAgent = false; f.paneId = "pane"; f.panePresent = true; f.blocked = false; f.outage = false; f.configFailure = false; f.journalFailure = false; f.appendFailures = 0; f.leaseFailures = 0; f.beforeLease = undefined;
  f.member = { name: "worker", agentType: "teammate", membershipId: "m", sessionFile: "/session", terminalTarget: { backend: "herdr", kind: "pane", targetId: "pane" } };
  f.status = { membershipId: "m", pid: 42, startedAt: 10, osBirthToken: "birth", bootId: "boot" };
});
it.each(["pane", "pane-2"])("records repeated terminal loss after low-noise presence at %s", async target => runWithHostEnv(env(), async () => {
  // Fixed sequence from c2-v3-terminal-probe.json, plus same-target recovery.
  const observer = await running();
  f.panePresent = false; await observer.refresh();
  f.paneId = target; f.member.terminalTarget.targetId = target; f.panePresent = true; await observer.refresh();
  f.panePresent = false; await observer.refresh(); await observer.refresh();
  expect(f.events.filter(e => e.carrier?.field === "terminal" && e.carrier.to === "absent").map(e => [e.carrier.paneId, e.carrier.from, e.carrier.to])).toEqual([
    ["pane", "present", "absent"], [target, "present", "absent"],
  ]); observer.stop();
}));
it.each(["appendFailures", "leaseFailures"] as const)("retries a lost carrier event after %s without changing fresh source truth", async failure => {
  const host = env();
  await runWithHostEnv(host, async () => {
    const observer = await running(); const initial = f.events.length; f[failure] = 1;
    host.process.generations = (async (pids: readonly number[]) => new Map(pids.map(pid => [pid, { kind: "absent" }]))) as any;
    await observer.refresh(); expect(observer.views.get("m")?.process).toBe("gone"); expect(f.events).toHaveLength(initial);
    f.now += 100; await observer.refresh(); await observer.refresh();
    expect(f.events.slice(initial).filter(e => e.carrier?.field === "process")).toHaveLength(1);
    expect(f.events[initial].carrier).toMatchObject({ from: "live", to: "gone" }); observer.stop();
  });
});
it("discards an unpublished predecessor death when a successor admits", async () => runWithHostEnv(env(), async () => {
  const observer = await running(); const initial = f.events.length; f.status.osBirthToken = "dead"; f.appendFailures = 1;
  await observer.refresh(); expect(f.events).toHaveLength(initial);
  f.status.osBirthToken = "birth"; f.status.startedAt = 20;
  await observer.refresh(); await observer.refresh();
  expect(observer.views.get("m")?.process).toBe("live");
  expect(f.events.slice(initial).filter(e => e.carrier?.field === "process").map(e => e.carrier.to)).toEqual(["live"]); observer.stop();
}));
it.each([1000, 20000])("journals verified reload death at %i ms, never false stopping", async delay => runWithHostEnv(env(), async () => {
  const observer = await running();
  f.status.lastStop = { piReason: "reload", observedAt: f.now, suspectedHumanStop: false };
  await observer.refresh(); f.now += delay; f.status.osBirthToken = "dead"; await observer.refresh();
  expect(observer.views.get("m")?.process).toBe("gone");
  expect(f.events.filter(e => e.carrier?.field === "process").map(e => e.carrier.to)).toEqual(["live", "gone"]);
  observer.stop(); const restarted = await running();
  expect(f.events.filter(e => e.carrier?.field === "process")).toHaveLength(2); restarted.stop();
}));
it("expires old truth after failed config and isolates failed journal reads", async () => runWithHostEnv(env(), async () => {
  const observer = await running(); f.now += 86400000; f.configFailure = true;
  await expect(observer.refresh()).rejects.toThrow("config unavailable");
  expect(observer.views.get("m")).toMatchObject({ process: "unknown", terminal: "unknown", activity: "unknown" });
  f.configFailure = false; f.journalFailure = true; f.status.osBirthToken = "dead";
  await observer.refresh(); expect(observer.views.get("m")?.process).toBe("gone"); observer.stop();
}));
it("keeps process sample time independent from delayed Herdr reads", async () => {
  const host = env(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = host.exec.run;
  host.exec.run = vi.fn(async (command, args) => { await held; return original(command, args); });
  await runWithHostEnv(host, async () => {
    const observer = new CarrierObserver("team"); const refresh = observer.refresh();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(observer.views.get("m")?.process).toBe("live");
    f.now += 7000; expect(observer.views.get("m")?.process).toBe("unknown");
    release(); await refresh;
    expect(observer.views.get("m")?.process).toBe("unknown");
    expect(observer.views.get("m")?.evidence[0].observedAt).toBe(1000);
  });
});
it("times out a stalled verifier without starting a duplicate flight", async () => {
  const host = env();
  const timers = new Map<number, () => void>(); let id = 0;
  host.clock.setTimeout = ((callback: () => void) => { timers.set(++id, callback); return id; }) as any;
  host.clock.clearTimeout = ((key: number) => { timers.delete(key); }) as any;
  const verifier = vi.fn(() => new Promise<Map<number, any>>(() => {}));
  host.process.generations = verifier;
  await runWithHostEnv(host, async () => {
    const observer = new CarrierObserver("team");
    for (let attempt = 0; attempt < 2; attempt++) {
      const refresh = observer.refresh();
      for (let i = 0; i < 30; i++) await Promise.resolve();
      f.now += 2000;
      for (const callback of [...timers.values()]) callback();
      await refresh;
      expect(observer.views.get("m")?.process).toBe("unknown");
      expect(observer.views.get("m")?.evidence.find(e => e.source === "process_generation")?.fact).toContain("process_generation_timeout");
      expect(observer.views.get("m")?.terminal).toBe("present");
    }
    expect(verifier).toHaveBeenCalledOnce();
  });
});
it("lets a current PTB stop request outrank earlier human suspicion and keeps launch cause", async () => runWithHostEnv(env(), async () => {
  f.status.osBirthToken = "dead"; f.status.stopRequested = "worker_stop";
  f.status.lastStop = { piReason: "quit", observedAt: 1, suspectedHumanStop: true };
  f.member.launch = { launchId: "launch", state: "refused", requestedAt: 1, observedAt: 20, fact: "agent_pane_busy: shell warming" };
  const observer = await running();
  expect(f.events.find(e => e.carrier?.field === "process").carrier).toMatchObject({ to: "gone", suspectedHumanStop: false });
  expect(f.events.find(e => e.carrier?.field === "launch").carrier).toMatchObject({ cause: { source: "launch", fact: "agent_pane_busy: shell warming" }, observedAt: 20 });
  observer.stop();
}));
it("emits one hung launch attention without authorizing another launch", async () => runWithHostEnv(env(), async () => {
  delete f.member.sessionFile; f.noAgent = true; f.member.launch = { launchId: "launch", state: "unknown", requestedAt: 1 };
  const observer = await running(); f.now += 16000; await observer.refresh(); await observer.refresh();
  expect(f.events.filter(e => e.carrier?.cause.fact === "launch_stalled")).toHaveLength(1);
  expect(f.events.find(e => e.carrier?.cause.fact === "launch_stalled").carrier).toMatchObject({ to: "unknown", paneId: "pane", nextActionHint: "ask_human" });
  observer.stop();
}));
it("rehydrates low-noise terminal changes and failed appends without a hidden checkpoint", async () => runWithHostEnv(env(), async () => {
  const notify = vi.fn(); let observer = new CarrierObserver("team", notify); observer.start(); await observer.refresh();
  f.panePresent = false; await observer.refresh();
  f.status.lastStop = { piReason: "quit", observedAt: f.now, suspectedHumanStop: true };
  f.panePresent = true; await observer.refresh();
  const notices = notify.mock.calls.length;
  f.outage = true; await observer.refresh();
  // The outage alert is separate. Terminal unknown/present must not ask for human action.
  expect(notify.mock.calls.slice(notices).flat().every(text => !String(text).includes("terminal"))).toBe(true);
  f.outage = false; await observer.refresh();
  for (const event of f.events.filter(e => e.carrier?.field === "terminal" && e.carrier.to !== "absent")) {
    expect(event.carrier).toMatchObject({ nextActionHint: "wait", suspectedHumanStop: false });
  }
  observer.stop(); observer = await running();
  f.appendFailures = 1; f.panePresent = false; await observer.refresh(); observer.stop();
  observer = await running(); await observer.refresh();
  expect(f.events.filter(e => e.carrier?.field === "terminal").map(e => e.carrier.to)).toEqual([
    "present", "absent", "present", "unknown", "present", "absent",
  ]); observer.stop();
}));
it("keeps the reload pair silent across restart using durable stop evidence", async () => runWithHostEnv(env(), async () => {
  let observer = await running(); const initial = f.events.length;
  f.status.lastStop = { piReason: "reload", observedAt: f.now, suspectedHumanStop: false };
  observer.stop(); observer = await running(); await observer.refresh();
  observer.stop(); delete f.status.lastStop; observer = await running();
  expect(f.events).toHaveLength(initial);
  f.status.lastStop = { piReason: "quit", observedAt: f.now, suspectedHumanStop: true }; await observer.refresh();
  expect(f.events.slice(initial).map(e => [e.carrier.field, e.carrier.to])).toEqual([["process", "stopping"]]); observer.stop();
}));
it.each(["backend", "kind", "targetId"])("fences a changed terminal-target %s before publication", async part => runWithHostEnv(env(), async () => {
  const observer = await running(); const initial = f.events.length;
  f.panePresent = false;
  f.beforeLease = () => { f.member.terminalTarget[part] = part === "kind" ? "window" : "replacement"; };
  await observer.refresh(); expect(f.events).toHaveLength(initial); observer.stop();
}));
it("keeps pane and window publication coordinates distinct even when their IDs match", async () => runWithHostEnv(env(), async () => {
  const observer = await running(); f.panePresent = false; await observer.refresh();
  f.member.terminalTarget.kind = "window"; f.panePresent = true; await observer.refresh();
  f.panePresent = false; await observer.refresh();
  expect(f.events.filter(e => e.carrier?.field === "terminal" && e.carrier.to === "absent").map(e => e.carrier.terminalTarget.kind)).toEqual(["pane", "window"]);
  observer.stop();
}));
const running = async () => { const observer = new CarrierObserver("team"); observer.start(); await observer.refresh(); return observer; };
it("keeps normal reload silent and reports a hung reload once", async () => runWithHostEnv(env(), async () => {
  const observer = await running(); const initial = f.events.length;
  f.status.lastStop = { piReason: "reload", observedAt: f.now, suspectedHumanStop: false };
  await observer.refresh();
  delete f.status.lastStop; await observer.refresh();
  expect(f.events).toHaveLength(initial);
  f.status.lastStop = { piReason: "reload", observedAt: f.now, suspectedHumanStop: false };
  await observer.refresh(); f.now += 16000; await observer.refresh(); await observer.refresh();
  expect(f.events).toHaveLength(initial + 1); expect(f.events[initial].carrier).toMatchObject({ to: "stopping", nextActionHint: "ask_human" });
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
  f.outage = true; const notify = vi.fn(); const observer = new CarrierObserver("team", notify); observer.start(); await observer.refresh(); await observer.refresh();
  expect(notify).toHaveBeenCalledOnce();
  expect(f.events.find(e => e.type === "alert").alertId).toMatch(/^herdr-observation:/);
  expect(f.events.filter(e => e.type === "alert")).toHaveLength(1);
  expect(observer.views.get("m")?.process).toBe("live");
  f.outage = false; await observer.refresh(); f.outage = true; await observer.refresh();
  expect(f.events.filter(e => e.type === "alert")).toHaveLength(2); observer.stop();
}));
it("does not journal diagnostic refreshes or repeat historical death", async () => runWithHostEnv(env(), async () => {
  f.status.osBirthToken = "dead";
  const diagnostic = new CarrierObserver("team"); await diagnostic.refresh(); expect(f.events).toEqual([]);
  const observer = await running(); const initial = f.events.length;
  expect(f.events.filter(e => e.carrier?.to === "gone")).toHaveLength(1); observer.stop();
  const restarted = await running(); expect(f.events).toHaveLength(initial); restarted.stop();
}));
