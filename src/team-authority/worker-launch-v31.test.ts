import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nodeHostEnv } from "../env/host-env";
import type { Member } from "./contracts";
import * as runtime from "../utils/runtime";
const fixture = vi.hoisted(() => ({ members: [] as Member[], separateWindows: false, mutations: [] as string[], leased: false, starts: 0, splits: 0, release: undefined as undefined | ((value: any) => void) }));
vi.mock("../utils/lock", async importOriginal => ({ ...await importOriginal<any>(), withLock: async (_: unknown, fn: () => unknown) => fn() }));
vi.mock("../utils/teams", () => ({
  readConfig: async () => ({ name: "team", terminalBackend: "herdr", members: fixture.members, separateWindows: fixture.separateWindows }),
  newLaunchId: () => `launch-${fixture.members.length + 1}`,
  newMembershipId: () => "membership",
  addMember: async (_: unknown, member: Member) => { fixture.mutations.push("add"); fixture.members.push(member); },
  withCurrentMembershipLease: async (_: unknown, id: string, fn: (member: Member) => unknown) => {
    fixture.leased = true;
    try { return await fn(fixture.members.find(m => m.membershipId === id)!); } finally { fixture.leased = false; }
  },
  updateMembership: async (_: unknown, id: string, updates: Partial<Member>) => { fixture.mutations.push("update"); return Object.assign(fixture.members.find(m => m.membershipId === id)!, updates); },
}));
vi.mock("../utils/team-pane-placement", () => ({ teamPanePlacement: () => ({ leaderPaneId: "leader", workerPaneIds: [] }) }));
vi.mock("../utils/team-terminal", async () => {
  const { HerdrAdapter } = await import("../adapters/herdr-adapter.js");
  const terminal = new HerdrAdapter();
  terminal.prepareSpawnAsync = async () => { expect(fixture.leased).toBe(false); fixture.splits++; return "pane"; };
  terminal.startPrepared = () => {
    expect(fixture.leased).toBe(false);
    expect(fixture.members[0].terminalTarget?.targetId).toBe("pane");
    fixture.starts++;
    return new Promise(resolve => { fixture.release = resolve; });
  };
  return { currentTerminalForTeamAsync: async () => terminal };
});
import { WorkerLaunchBridge } from "./worker-launch-bridge";
import { deriveCarrierView } from "../carrier-observation";
import { createModelToolJourneyExecutors } from "../model-tool-contract/executors";
import { projectToolResult } from "../model-tool-contract/result-projection";
import { projectToolTuiMessage } from "../model-tool-contract/tui-projection";

beforeEach(() => { fixture.members = []; fixture.separateWindows = false; fixture.mutations = []; fixture.leased = false; fixture.splits = 0; fixture.starts = 0; });
afterEach(() => { vi.restoreAllMocks(); });
it.each(["started", "unknown"] as const)("returns launch_stalled for an old %s launch with no agent in its pane", async state => {
  fixture.members = [{ name: "worker", agentType: "teammate", membershipId: "membership", terminalTarget: { backend: "herdr", kind: "pane", targetId: "pane" },
    launch: { launchId: "launch", state, requestedAt: Date.now() - 16000 } } as Member];
  const run = vi.spyOn(nodeHostEnv.exec, "run").mockResolvedValue({ kind: "exited", status: 0, stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" });
  const bridge = new WorkerLaunchBridge({ buildWorkerArgv: () => ["pi"], workerAggregate: () => ({ projectTrusted: false }), lifecyclePublication: {} as any });
  const request = { teamName: "team", workerName: "worker", cwd: "/fixture", scope: "test" };
  expect(await bridge.ensureWorker(request)).toMatchObject({ action: "attention", reason: "launch_stalled", nextActionHint: "ask_human", paneId: "pane", launchId: "launch" });
  expect(fixture.splits).toBe(0); expect(fixture.starts).toBe(0);
  run.mockResolvedValue({ kind: "exited", status: 0, stdout: JSON.stringify({ result: { agents: [{ pane_id: "pane", name: "foreign-agent" }] } }), stderr: "" });
  expect(await bridge.ensureWorker(request)).toMatchObject({ action: "attention", reason: "launch_pending", nextActionHint: "wait" });
  run.mockResolvedValue({ kind: "timeout", afterMs: 2000 });
  expect(await bridge.ensureWorker(request)).toMatchObject({ reason: "launch_pending", nextActionHint: "wait" });
  fixture.members[0].launch!.requestedAt = Date.now(); run.mockClear();
  expect(await bridge.ensureWorker(request)).toMatchObject({ reason: "launch_pending", nextActionHint: "wait" });
  expect(run).not.toHaveBeenCalled();
});
it.each(["missing", "prior"])("reports a hung recovery with %s runtime as stalled without starting another Pi", async runtimeKind => {
  const priorGeneration = { pid: 321, osBirthToken: "birth", bootId: "boot" };
  fixture.members = [{ name: "worker", agentType: "teammate", membershipId: "membership", sessionFile: "/sessions/worker.jsonl",
    terminalTarget: { backend: "herdr", kind: "pane", targetId: "pane" },
    launch: { launchId: "recovery", state: "started", requestedAt: Date.now() - 16000, priorGeneration } } as Member];
  vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue(runtimeKind === "missing" ? null
    : { teamName: "team", agentName: "worker", membershipId: "membership", startedAt: 1, ...priorGeneration });
  vi.spyOn(nodeHostEnv.process, "generation").mockReturnValue({ kind: "absent" });
  vi.spyOn(nodeHostEnv.exec, "run").mockResolvedValue({ kind: "exited", status: 0, stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" });
  const bridge = new WorkerLaunchBridge({ buildWorkerArgv: () => ["pi"], workerAggregate: () => ({ projectTrusted: false }), lifecyclePublication: {} as any });
  expect(await bridge.ensureWorker({ teamName: "team", workerName: "worker", cwd: "/fixture", scope: "test" }))
    .toMatchObject({ action: "attention", reason: "launch_stalled", nextActionHint: "ask_human", launchId: "recovery" });
  expect(fixture.mutations).toEqual([]); expect(fixture.splits).toBe(0); expect(fixture.starts).toBe(0);
});
it("rechecks recovery admission under the Membership lease after the Herdr read", async () => {
  const priorGeneration = { pid: 321, osBirthToken: "birth", bootId: "boot" };
  fixture.members = [{ name: "worker", agentType: "teammate", membershipId: "membership", sessionFile: "/sessions/worker.jsonl",
    terminalTarget: { backend: "herdr", kind: "pane", targetId: "pane" },
    launch: { launchId: "recovery", state: "started", requestedAt: Date.now() - 16000, priorGeneration } } as Member];
  let status = { teamName: "team", agentName: "worker", membershipId: "membership", startedAt: 1, ...priorGeneration };
  vi.spyOn(runtime, "readRuntimeStatus").mockImplementation(async () => status);
  vi.spyOn(nodeHostEnv.process, "generation").mockReturnValue({ kind: "absent" });
  vi.spyOn(nodeHostEnv.exec, "run").mockImplementation(async () => {
    status = { ...status, pid: 322, osBirthToken: "successor", startedAt: 2 };
    return { kind: "exited", status: 0, stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" };
  });
  const bridge = new WorkerLaunchBridge({ buildWorkerArgv: () => ["pi"], workerAggregate: () => ({ projectTrusted: false }), lifecyclePublication: {} as any });
  expect(await bridge.ensureWorker({ teamName: "team", workerName: "worker", cwd: "/fixture", scope: "test" }))
    .toMatchObject({ action: "attention", reason: "launch_pending", nextActionHint: "wait" });
  expect(fixture.mutations).toEqual([]); expect(fixture.splits).toBe(0); expect(fixture.starts).toBe(0);
});
it.each(["pid", "osBirthToken", "bootId"] as const)("preserves successor stop attention after recovery with changed %s", async changed => {
  const priorGeneration = { pid: 321, osBirthToken: "birth", bootId: "boot" };
  fixture.members = [{ name: "worker", agentType: "teammate", membershipId: "membership", sessionFile: "/sessions/worker.jsonl",
    terminalTarget: { backend: "herdr", kind: "pane", targetId: "pane" },
    launch: { launchId: "recovery", state: "started", requestedAt: Date.now() - 16000, priorGeneration } } as Member];
  vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue({ teamName: "team", agentName: "worker", membershipId: "membership", startedAt: 2,
    ...priorGeneration, [changed]: changed === "pid" ? 322 : "successor", lastStop: { piReason: "new", observedAt: 3, suspectedHumanStop: true } });
  vi.spyOn(nodeHostEnv.process, "generation").mockReturnValue({ kind: "absent" });
  const run = vi.spyOn(nodeHostEnv.exec, "run").mockResolvedValue({ kind: "exited", status: 0, stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" });
  const bridge = new WorkerLaunchBridge({ buildWorkerArgv: () => ["pi"], workerAggregate: () => ({ projectTrusted: false }), lifecyclePublication: {} as any });
  expect(await bridge.ensureWorker({ teamName: "team", workerName: "worker", cwd: "/fixture", scope: "test" }))
    .toMatchObject({ action: "attention", reason: "session_switched", nextActionHint: "ask_human" });
  expect(run).not.toHaveBeenCalled(); expect(fixture.mutations).toEqual([]); expect(fixture.splits).toBe(0); expect(fixture.starts).toBe(0);
});
it.each([
  { stop: "new", process: "gone", reason: "session_switched", hint: "ask_human" },
  { stop: "resume", process: "gone", reason: "session_switched", hint: "ask_human" },
  { stop: "fork", process: "gone", reason: "session_switched", hint: "ask_human" },
  { stop: "quit", process: "live", reason: "stopping", hint: "ask_human" },
  { stop: "quit", process: "unknown", reason: "unknown", hint: "ask_human" },
  { stop: undefined, process: "unknown", reason: "unknown", hint: "wait" },
] as const)("preserves bound planner attention after $stop with $process process beyond the launch stall deadline", async ({ stop, process, reason, hint }) => {
  fixture.members = [{ name: "worker", agentType: "teammate", membershipId: "membership", sessionFile: "/sessions/worker.jsonl",
    terminalTarget: { backend: "herdr", kind: "pane", targetId: "pane" },
    launch: { launchId: "launch", state: "started", requestedAt: Date.now() - 16000 } } as Member];
  vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue({ teamName: "team", agentName: "worker", membershipId: "membership", pid: 321, startedAt: 1,
    osBirthToken: "birth", bootId: "boot", ...(stop ? { lastStop: { piReason: stop, observedAt: 2, suspectedHumanStop: true } } : {}) });
  vi.spyOn(nodeHostEnv.process, "generation").mockReturnValue(process === "gone" ? { kind: "absent" }
    : process === "live" ? { kind: "found", generation: { pid: 321, osBirthToken: "birth", bootId: "boot" } }
    : { kind: "unknown", reason: "probe_unavailable" });
  const run = vi.spyOn(nodeHostEnv.exec, "run").mockResolvedValue({ kind: "exited", status: 0, stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" });
  const prior = structuredClone(fixture.members);
  const bridge = new WorkerLaunchBridge({ buildWorkerArgv: () => ["pi"], workerAggregate: () => ({ projectTrusted: false }), lifecyclePublication: {} as any });
  expect(await bridge.ensureWorker({ teamName: "team", workerName: "worker", cwd: "/fixture", scope: "test" }))
    .toMatchObject({ action: "attention", reason, nextActionHint: hint, membershipId: "membership" });
  expect(run).not.toHaveBeenCalled();
  expect(fixture.members).toEqual(prior);
  expect(fixture.mutations).toEqual([]);
  expect(fixture.splits).toBe(0);
  expect(fixture.starts).toBe(0);
});
it.each(["none", "requested", "started", "unknown", "refused"] as const)("preserves G11 for a bound tokenless Worker with %s launch evidence", async state => {
  fixture.members = [{ name: "worker", agentType: "teammate", membershipId: "membership", sessionFile: "/sessions/worker.jsonl",
    terminalTarget: { backend: "herdr", kind: "pane", targetId: "pane" },
    ...(state === "none" ? {} : { launch: { launchId: "launch", state, requestedAt: Date.now() - 16000 } }) } as Member];
  vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue({ teamName: "team", agentName: "worker", membershipId: "membership", pid: 321, startedAt: 1 });
  const run = vi.spyOn(nodeHostEnv.exec, "run").mockResolvedValue({ kind: "exited", status: 0, stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" });
  const bridge = new WorkerLaunchBridge({ buildWorkerArgv: () => ["pi"], workerAggregate: () => ({ projectTrusted: false }), lifecyclePublication: {} as any });
  expect(await bridge.ensureWorker({ teamName: "team", workerName: "worker", cwd: "/fixture", scope: "test" }))
    .toMatchObject({ action: "attention", reason: "legacy_unverified", nextActionHint: "ask_human", membershipId: "membership" });
  expect(run).not.toHaveBeenCalled();
  expect(fixture.splits).toBe(0);
  expect(fixture.starts).toBe(0);
  expect(fixture.members[0].sessionFile).toBe("/sessions/worker.jsonl");
});
it.each(["absent", "found", "unknown"] as const)("ensure_worker preserves the carrier's legacy %s advice without actuation", async kind => {
  const member = { name: "worker", agentType: "teammate", membershipId: "membership", sessionFile: "/sessions/worker.jsonl",
    terminalTarget: { backend: "herdr", kind: "pane", targetId: "pane" } } as Member;
  fixture.members = [member];
  const status = { teamName: "team", agentName: "worker", membershipId: "membership", pid: 321, startedAt: 1 };
  vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue(status);
  const probe = kind === "found" ? { kind, generation: { pid: 321, osBirthToken: "birth", bootId: "boot" } }
    : kind === "unknown" ? { kind, reason: "probe_unavailable" } : { kind };
  vi.spyOn(nodeHostEnv.process, "generation").mockReturnValue(probe);
  const run = vi.spyOn(nodeHostEnv.exec, "run");
  const bridge = new WorkerLaunchBridge({ buildWorkerArgv: () => ["pi"], workerAggregate: () => ({ projectTrusted: false }), lifecyclePublication: {} as any });
  const result = await bridge.ensureWorker({ teamName: "team", workerName: "worker", cwd: "/fixture", scope: "test" });
  expect(result).toMatchObject({ action: "attention", reason: "legacy_unverified", nextActionHint: "ask_human", message: deriveCarrierView(member, status).attention!.message });
  const executors = createModelToolJourneyExecutors({ team: { ensureWorker: async () => ({ ...result, kind: "attention", worker: { name: "worker" } }) } } as any);
  const model = projectToolResult("ensure_worker", await executors.ensureWorker("lead" as any, { name: "worker", scope: "test" })) as any;
  expect(model.message).toMatch(kind === "absent" ? /^Restart.*or stop the Worker/ : kind === "found" ? /^Reload.*or adopt it/ : /^Verify/);
  expect(model.message).toContain(`probe=${kind === "found" ? "present" : kind}`);
  expect(model.message).toContain("pid=321");
  expect(model.message).toContain("Unknown generation evidence never authorizes");
  expect(run).not.toHaveBeenCalled(); expect(fixture.starts).toBe(0); expect(fixture.splits).toBe(0); expect(fixture.mutations).toEqual([]);
});
it.each([true, false])("missing macOS helper gives actionable attention without spawning (tokened=%s)", async tokened => {
  fixture.members = [{ name: "worker", agentType: "teammate", membershipId: "membership", sessionFile: "/sessions/worker.jsonl",
    terminalTarget: { backend: "herdr", kind: "pane", targetId: "pane" },
    launch: { launchId: "launch", state: "started", requestedAt: Date.now() - 16000 } } as Member];
  vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue({ teamName: "team", agentName: "worker", membershipId: "membership", pid: 321, startedAt: 1,
    ...(tokened ? { osBirthToken: "1:2", bootId: "3:4" } : {}) });
  vi.spyOn(nodeHostEnv.process, "generation").mockReturnValue({ kind: "unknown", reason: "generation_helper_missing" });
  const run = vi.spyOn(nodeHostEnv.exec, "run").mockResolvedValue({ kind: "exited", status: 0, stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" });
  const bridge = new WorkerLaunchBridge({ buildWorkerArgv: () => ["pi"], workerAggregate: () => ({ projectTrusted: false }), lifecyclePublication: {} as any });
  const result = await bridge.ensureWorker({ teamName: "team", workerName: "worker", cwd: "/fixture", scope: "test" });
  expect(result).toMatchObject({ action: "attention", reason: "generation_helper_missing", nextActionHint: "ask_human" });
  const executors = createModelToolJourneyExecutors({ team: { ensureWorker: async () => ({ ...result, kind: "attention", worker: { name: "worker" } }) } } as any);
  const details = await executors.ensureWorker("lead" as any, { name: "worker", scope: "test" });
  const served = projectToolResult("ensure_worker", details) as any;
  expect(served.message).toMatch(/macOS.*helper.*missing/i);
  expect(served.message).toContain("npm run build:process-generation");
  expect(served.message).toContain("rustc");
  expect(projectToolTuiMessage({ tool: "ensure_worker", details, expanded: false }).body?.join("\n")).toContain(served.message);
  expect(run).not.toHaveBeenCalled();
  expect(fixture.splits).toBe(0);
  expect(fixture.starts).toBe(0);
});
it.each(["create", "prepared recovery", "bound recovery"])("refuses unsupported separate windows before %s claim or effects", async scenario => {
  fixture.separateWindows = true;
  if (scenario !== "create") fixture.members = [{ name: "worker", agentType: "teammate", membershipId: "membership",
    ...(scenario === "bound recovery" ? { sessionFile: "/sessions/worker.jsonl" } : { pendingLaunchId: "prior-launch" }),
    launch: { launchId: "prior-launch", state: "refused", requestedAt: 1 } } as Member];
  vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue(scenario === "bound recovery"
    ? { teamName: "team", agentName: "worker", membershipId: "membership", pid: 321, startedAt: 1, osBirthToken: "birth", bootId: "boot" } : null);
  vi.spyOn(nodeHostEnv.process, "generation").mockReturnValue({ kind: "absent" });
  const prior = structuredClone(fixture.members);
  const aggregate = vi.fn(() => ({ projectTrusted: false }));
  const publish = vi.fn(async () => ({ cursor: "1" }));
  const bridge = new WorkerLaunchBridge({ buildWorkerArgv: () => ["pi"], workerAggregate: aggregate, lifecyclePublication: { recordWorkerPrepared: publish, readEventCursor: () => "0" } as any });
  await expect(bridge.ensureWorker({ teamName: "team", workerName: "worker", cwd: "/workspace", scope: "test", modelProfile: { provider: "fixture", model: "small" } }))
    .rejects.toThrow("Separate windows mode is not supported in herdr.");
  expect(fixture.members).toEqual(prior);
  expect(fixture.mutations).toEqual([]);
  expect(aggregate).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(fixture.splits).toBe(0);
  expect(fixture.starts).toBe(0);
});
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
