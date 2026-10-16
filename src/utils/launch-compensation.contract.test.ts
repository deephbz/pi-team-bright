import { terminalFixture } from "../../test/terminal-fixture";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { clearAdapterCache, setAdapter } from "../adapters/terminal-registry";
import { nodeHostEnv } from "../env/host-env";
import type { TerminalAdapter } from "./terminal-adapter";
import * as paths from "./paths";
import * as runtime from "./runtime";
import * as teams from "./teams";
import { projectTui } from "../model-tool-contract/tui-projection";
import { DurableTeamLifecyclePublication } from "../adapters/durable-team-lifecycle-publication";
import { createWorkerLaunchBridge as createRuntimeWorkerLaunchBridge, WorkerLegacyTeamModelDefaultError, type WorkerLaunchBridgeDependencies, type WorkerLaunchRequest } from "../team-authority/worker-launch-bridge";
import { materializeWorkerAggregate } from "./worker-resource-projection";
import type { ModelRoleSettings } from "./model-role-settings";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: any, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<any>;
};
const created: string[] = [];
const aggregates: string[] = [];
const fixtureModelRoleSettings: ModelRoleSettings = {
  roles: { fixture: { model: "fixture/model", thinking: "low", use: "Carrier lifecycle tests" } },
  defaultRole: "fixture", diagnostics: [], invalidRoles: new Set(), invalidDefault: false,
  invalidRoleMap: false, invalidGlobalRoleMap: false, invalidProjectRoleMap: false,
  roleSources: { fixture: "global" }, sourceFiles: { global: "/fixture/global.json", project: "/fixture/project.json" },
};
const fixtureAvailableModelKeys = Object.assign(new Set(["fixture/model"]), {
  thinkingLevelsByKey: new Map([["fixture/model", new Set(["low" as const])]]),
});
function createWorkerLaunchBridge(dependencies: WorkerLaunchBridgeDependencies) {
  const originalAggregate = dependencies.workerAggregate;
  const bridge = createRuntimeWorkerLaunchBridge({ ...dependencies, workerAggregate: cwd => ({
    modelRoleSettings: fixtureModelRoleSettings, ...originalAggregate(cwd),
  }) });
  const ensureWorker = bridge.ensureWorker.bind(bridge);
  bridge.ensureWorker = (request: WorkerLaunchRequest) => ensureWorker({
    ...request, availableModelKeys: request.availableModelKeys ?? fixtureAvailableModelKeys,
  });
  return bridge;
}
function context(sessionFile: string) {
  return {
    cwd: process.cwd(),
    modelRegistry: { getAvailable: () => [{ provider: "fixture", id: "model", reasoning: true }] },
    sessionManager: { getSessionFile: () => sessionFile, getBranch: () => [], buildContextEntries: () => [] },
    ui: { setStatus() {}, notify() {} },
  };
}
function adapter(options: { alive?: boolean; name?: string } = {}) {
  const spawn = vi.fn((_options: any) => "pane-worker");
  const kill = vi.fn();
  const terminal = terminalFixture({
    name: options.name ?? "launch-contract-terminal", currentTargetId: () => null,
    prepareSpawn: async options => spawn(options), kill,
    isAlive: vi.fn(async () => options.alive ?? false), prepareWindow: async () => "window-worker",
  });
  return { terminal, spawn, kill };
}
function register(terminal: TerminalAdapter): Map<string, RegisteredTool> {
  setAdapter(terminal);
  const tools = new Map<string, RegisteredTool>();
  piTeams({ registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); }, on() {}, sendUserMessage() {} } as never);
  return tools;
}
async function team(suffix: string, defaultModel?: string, terminalBackend = "launch-contract-terminal") {
  const name = `launch-comp-${suffix}-${process.pid}-${Date.now()}-${created.length}`;
  created.push(name);
  const leadSession = `/tmp/${name}-lead.jsonl`;
  const teamDirectory = paths.teamDir(name);
  const agentDir = path.join(teamDirectory, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ pi_team_bright: {
    model_roles: { fixture: { model: "fixture/model", thinking: "low", use: "Carrier lifecycle tests" } }, default_model_role: "fixture",
  } }));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  if (terminalBackend === "herdr") {
    vi.stubEnv("HERDR_ENV", "1"); vi.stubEnv("HERDR_PANE_ID", "pane-leader"); vi.stubEnv("HERDR_TAB_ID", "tab-fixture");
  }
  await teams.createTeam(name, leadSession, "lead", undefined, defaultModel, undefined, undefined,
    { backend: terminalBackend, leadTarget: { backend: terminalBackend, kind: "pane", targetId: "pane-leader" } });
  return { name, leadSession };
}
function bridge(lifecyclePublication = new DurableTeamLifecyclePublication()) {
  return createWorkerLaunchBridge({ buildWorkerArgv: () => ["pi"], workerAggregate: () => ({ projectTrusted: false }), lifecyclePublication });
}
function request(teamName: string): WorkerLaunchRequest {
  return { teamName, workerName: "worker", scope: "Own focused work.", cwd: process.cwd() };
}
async function prepared(teamName: string, backend = "launch-contract-terminal") {
  const launchId = teams.newLaunchId();
  const member = {
    membershipId: teams.newMembershipId(), pendingLaunchId: launchId,
    launch: { launchId, state: "refused" as const, requestedAt: Date.now(), fact: "fixture_start_refused" },
    agentId: `worker@${teamName}`, name: "worker", agentType: "teammate" as const, joinedAt: Date.now(), cwd: process.cwd(),
    subscriptions: [], isActive: true, prompt: "Own focused work.", color: "blue",
    terminalTarget: { backend, kind: "pane" as const, targetId: "pane-prior" },
  };
  await teams.addMember(teamName, member);
  return member;
}
async function settledLaunch(teamName: string, state: "started" | "unknown", fact?: string) {
  await vi.waitFor(async () => {
    expect((await teams.currentMembership(teamName, "worker")).launch).toMatchObject({ state, ...(fact ? { fact } : {}) });
  });
}
function failNextTargetWrite(message: string) {
  const apply = teams.applyMembershipEvent;
  let failed = false;
  vi.spyOn(teams, "applyMembershipEvent").mockImplementation((teamName, membershipId, event) => {
    if ((event.type === "record_target" || (event.type === "complete_launch" && event.target)) && !failed) { failed = true; return Promise.reject(new Error(message)); }
    return apply(teamName, membershipId, event);
  });
}
async function bindLive(teamName: string, sessionFile: string) {
  const current = await teams.currentMembership(teamName, "worker");
  await teams.bindMemberSession(teamName, "worker", sessionFile, current.pendingLaunchId, {}, current.membershipId);
  await runtime.writeRuntimeStatus(teamName, "worker", {
    pid: process.pid, startedAt: Date.now(), osBirthToken: "fixture-birth", bootId: "fixture-boot", ready: false,
  }, current.membershipId);
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); clearAdapterCache();
  for (const name of created.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
  for (const file of aggregates.splice(0)) fs.rmSync(file, { force: true });
});

// Decision 0021 replaces timeout/error compensation with retained launch evidence.
describe("receipt-first Worker launch", () => {
  it("retains a recovery target after persistence failure and leaves Session admission to its child", async () => {
    const f = await team("recovery-persistence-failure"); const a = adapter(); setAdapter(a.terminal);
    const member = await prepared(f.name);
    failNextTargetWrite("recovery target write failed");
    const receipt = await bridge().ensureWorker(request(f.name));
    expect(receipt).toMatchObject({ action: "recovered", launch: "requested", target: { terminalId: "pane-worker" } });
    if (receipt.action !== "recovered") throw new Error("Expected recovery receipt");
    await settledLaunch(f.name, "unknown", "recovery target write failed");
    expect(a.kill).not.toHaveBeenCalled();
    expect(await teams.currentMembership(f.name, "worker")).toMatchObject({
      membershipId: member.membershipId, isActive: true, pendingLaunchId: receipt.launchId,
      terminalTarget: { targetId: "pane-worker" },
    });
    expect(await runtime.readRuntimeStatus(f.name, "worker")).toBeNull();
  });

  it("returns a receipt without entering the cancelled readiness observer", async () => {
    const f = await team("herdr-cancelled-start", undefined, "herdr"); const a = adapter({ name: "herdr", alive: true }); setAdapter(a.terminal);
    const lifecycle = new DurableTeamLifecyclePublication();
    const observe = vi.spyOn(lifecycle, "observeWorkerStartup").mockRejectedValue(new Error("readiness observation must not run"));
    const controller = new AbortController(); controller.abort();
    expect(await bridge(lifecycle).ensureWorker({ ...request(f.name), signal: controller.signal })).toMatchObject({
      action: "created", launch: "requested", startup: { observed: false, reason: "requested" },
    });
    await settledLaunch(f.name, "started");
    expect(observe).not.toHaveBeenCalled(); expect(a.kill).not.toHaveBeenCalled();
    expect((await teams.currentMembership(f.name, "worker")).isActive).toBe(true);
  });

  it("does not stop a Session that binds after the receipt and caller cancellation", async () => {
    const f = await team("herdr-cancelled-binding", undefined, "herdr"); const a = adapter({ name: "herdr", alive: true }); setAdapter(a.terminal);
    const controller = new AbortController(); const service = bridge();
    const receipt = await service.ensureWorker({ ...request(f.name), signal: controller.signal }); controller.abort();
    await settledLaunch(f.name, "started"); await bindLive(f.name, "/tmp/herdr-cancelled-binding.jsonl");
    expect(receipt).toMatchObject({ action: "created", startup: { observed: false } });
    expect(await service.ensureWorker(request(f.name))).toMatchObject({ action: "reused", membershipId: receipt.membershipId });
    expect(a.kill).not.toHaveBeenCalled(); expect(a.spawn).toHaveBeenCalledOnce();
  });

  it("keeps an unbound Herdr pane when the historical readiness bound is zero", async () => {
    vi.stubEnv("PI_TEAMS_WORKER_STARTUP_WAIT_MS", "0");
    const f = await team("herdr-unbound-timeout", undefined, "herdr"); const a = adapter({ name: "herdr", alive: true }); setAdapter(a.terminal);
    const service = bridge();
    expect(await service.ensureWorker(request(f.name))).toMatchObject({ action: "created", startup: { observed: false, reason: "requested" } });
    await settledLaunch(f.name, "started");
    expect(a.kill).not.toHaveBeenCalled();
    expect(await teams.currentMembership(f.name, "worker")).toMatchObject({ isActive: true, terminalTarget: { targetId: "pane-worker" } });
    expect(await runtime.readRuntimeStatus(f.name, "worker")).toBeNull();
  });

  it("does not spawn another pane when an unbound launch is retried", async () => {
    const f = await team("herdr-unbound-retry", undefined, "herdr"); const a = adapter({ name: "herdr" }); setAdapter(a.terminal);
    const service = bridge(); const first = await service.ensureWorker(request(f.name)); await settledLaunch(f.name, "started");
    if (first.action !== "created") throw new Error("Expected creation receipt");
    expect(await service.ensureWorker(request(f.name))).toMatchObject({
      action: "attention", reason: "launch_pending", nextActionHint: "wait", membershipId: first.membershipId, launchId: first.launchId,
    });
    expect(a.spawn).toHaveBeenCalledOnce(); expect(a.kill).not.toHaveBeenCalled();
    expect((await teams.readConfig(f.name)).members.filter(m => m.agentType === "teammate")).toHaveLength(1);
  });

  it("does not mistake a live shell for a reusable unbound Worker", async () => {
    const f = await team("herdr-unbound-live", undefined, "herdr"); const a = adapter({ name: "herdr", alive: true }); setAdapter(a.terminal);
    const service = bridge(); await service.ensureWorker(request(f.name)); await settledLaunch(f.name, "started");
    expect(await service.ensureWorker(request(f.name))).toMatchObject({ action: "attention", reason: "launch_pending" });
    expect(a.spawn).toHaveBeenCalledOnce(); expect(a.kill).not.toHaveBeenCalled();
    expect(a.terminal.isAlive).not.toHaveBeenCalled();
  });

  it("reuses the recovered exact Session only after its new generation binds", async () => {
    const f = await team("herdr-recovery-binding", undefined, "herdr"); const a = adapter({ name: "herdr" }); setAdapter(a.terminal);
    const member = await prepared(f.name, "herdr");
    await teams.bindMemberSession(f.name, "worker", "/tmp/herdr-recovery.jsonl", member.pendingLaunchId, {}, member.membershipId);
    await runtime.writeRuntimeStatus(f.name, "worker", { pid: 2_147_483_647, startedAt: 1, osBirthToken: "old-birth", bootId: "fixture-boot" }, member.membershipId);
    const generations = nodeHostEnv.process.generations;
    vi.spyOn(nodeHostEnv.process, "generations").mockImplementation(async pids => {
      const results = await generations(pids);
      if (pids.includes(2_147_483_647)) results.set(2_147_483_647, { kind: "absent" });
      return results;
    });
    const service = bridge(); const receipt = await service.ensureWorker(request(f.name));
    expect(receipt).toMatchObject({ action: "recovered", recoveryMode: "exact_session_resume", startup: { observed: false } });
    await settledLaunch(f.name, "started");
    expect(await service.ensureWorker(request(f.name))).toMatchObject({ action: "attention", reason: "launch_pending" });
    await runtime.writeRuntimeStatus(f.name, "worker", { pid: process.pid, startedAt: Date.now(), osBirthToken: "fixture-birth", bootId: "fixture-boot" }, member.membershipId);
    expect(await service.ensureWorker(request(f.name))).toMatchObject({ action: "reused", membershipId: member.membershipId });
    expect(a.spawn).toHaveBeenCalledOnce(); expect(a.kill).not.toHaveBeenCalled();
    expect(a.spawn.mock.calls[0][0].argv).toEqual(["pi", "--session", "/tmp/herdr-recovery.jsonl"]);
  });

  it("serializes concurrent recovery claims without deleting the winning aggregate", async () => {
    const f = await team("concurrent-recovery"); const a = adapter(); setAdapter(a.terminal);
    const member = await prepared(f.name);
    const resource = vi.fn(() => {
      const file = materializeWorkerAggregate({ cwd: process.cwd(), policy: {
        appendGlobal: { path: "/fixture/worker.md", content: "Worker policy" }, enable: [], disable: [], diagnostics: [], modelRoleSettings: fixtureModelRoleSettings,
      } })!;
      aggregates.push(file); return { path: file, projectTrusted: false };
    });
    const service = createWorkerLaunchBridge({ buildWorkerArgv: () => ["pi"], workerAggregate: resource, lifecyclePublication: new DurableTeamLifecyclePublication() });
    const outcomes = await Promise.all([service.ensureWorker(request(f.name)), service.ensureWorker(request(f.name))]);
    expect(outcomes.map(o => o.action).sort()).toEqual(["attention", "recovered"]);
    expect(outcomes.find(o => o.action === "attention")).toMatchObject({ reason: "launch_pending" });
    await settledLaunch(f.name, "started");
    expect(a.spawn).toHaveBeenCalledOnce(); expect(resource).toHaveBeenCalledOnce();
    const file = a.spawn.mock.calls[0][0].env.PI_TEAM_BRIGHT_WORKER_AGGREGATE;
    expect(file).toBe(aggregates[0]); expect(fs.existsSync(file)).toBe(true);
    expect(await teams.currentMembership(f.name, "worker")).toMatchObject({ membershipId: member.membershipId, terminalTarget: { targetId: "pane-worker" } });
  });

  it("passes only durable Team pane targets for first and later Workers", async () => {
    const f = await team("pane-placement"); const a = adapter(); a.spawn.mockReturnValueOnce("pane-worker-1").mockReturnValueOnce("pane-worker-2"); setAdapter(a.terminal);
    const service = bridge();
    await service.ensureWorker({ ...request(f.name), workerName: "worker-1" });
    await service.ensureWorker({ ...request(f.name), workerName: "worker-2" });
    expect(a.spawn).toHaveBeenNthCalledWith(1, expect.objectContaining({ panePlacement: { leaderPaneId: "pane-leader", workerPaneIds: [] } }));
    expect(a.spawn).toHaveBeenNthCalledWith(2, expect.objectContaining({ panePlacement: { leaderPaneId: "pane-leader", workerPaneIds: ["pane-worker-1"] } }));
    await vi.waitFor(async () => expect((await teams.readConfig(f.name)).members.filter(m => m.agentType === "teammate").map(m => m.launch?.state)).toEqual(["started", "started"]));
  });

  it("preserves a resolved model role through decisively refused prepared recovery", async () => {
    const captured: Array<string | undefined> = []; const f = await team("role-recovery"); const a = adapter(); setAdapter(a.terminal);
    const service = createWorkerLaunchBridge({ buildWorkerArgv: model => { captured.push(model); return ["pi"]; }, workerAggregate: () => ({ projectTrusted: false }), lifecyclePublication: new DurableTeamLifecyclePublication() });
    const first = await service.ensureWorker(request(f.name)); await settledLaunch(f.name, "started");
    expect(first.member?.modelProfile).toMatchObject({ alias: "fixture", provider: "fixture", model: "model", thinking: "low" });
    if (first.action !== "created") throw new Error("Expected creation receipt");
    await service.completeLaunch(f.name, first.membershipId, first.launchId, { state: "refused", fact: "fixture_start_refused" });
    const recovered = await service.ensureWorker(request(f.name)); await settledLaunch(f.name, "started");
    expect(recovered.action).toBe("recovered"); expect(recovered.member?.modelProfile).toEqual(first.member?.modelProfile);
    if (recovered.action !== "recovered") throw new Error("Expected recovery receipt");
    expect(recovered.launchId).not.toBe(first.launchId); expect(captured).toEqual(["fixture/model", "fixture/model"]);
  });

  it("refuses a legacy Team raw default before Membership or carrier creation", async () => {
    const f = await team("legacy-team-default", "legacy/model"); const a = adapter(); setAdapter(a.terminal);
    await expect(bridge().ensureWorker(request(f.name))).rejects.toBeInstanceOf(WorkerLegacyTeamModelDefaultError);
    expect(a.spawn).not.toHaveBeenCalled();
    expect((await teams.readConfig(f.name)).members.find(m => m.name === "worker")).toBeUndefined();
  });

  it("does not create a Worker carrier when Membership preparation persistence fails", async () => {
    const f = await team("preparation-failure"); const a = adapter(); const tools = register(a.terminal);
    vi.spyOn(teams, "addMember").mockRejectedValueOnce(new Error("membership write failed"));
    const result = await tools.get("ensure_worker")!.execute("ensure", { name: "worker", scope: "Do focused work" }, undefined, undefined, context(f.leadSession));
    expect(result.details).toMatchObject({ kind: "unavailable", reason: "carrier_unavailable" });
    expect(result.details.message).toContain("membership write failed"); expect(a.spawn).not.toHaveBeenCalled();
    expect((await teams.readConfig(f.name)).members.find(m => m.name === "worker")).toBeUndefined();
  });

  it("retains the launch marker when terminal startup throws before a target is returned", async () => {
    const f = await team("terminal-launch-failure"); const a = adapter(); a.spawn.mockImplementationOnce(() => { throw new Error("terminal launch failed"); });
    const tools = register(a.terminal);
    const result = await tools.get("ensure_worker")!.execute("ensure", { name: "worker", scope: "Do focused work" }, undefined, undefined, context(f.leadSession));
    expect(result.details).toMatchObject({ kind: "worker_ensured", effect: "created", launch: "requested" });
    await settledLaunch(f.name, "unknown", "terminal launch failed"); expect(a.kill).not.toHaveBeenCalled();
    expect(await teams.currentMembership(f.name, "worker")).toMatchObject({ isActive: true });
    const retry = await tools.get("ensure_worker")!.execute("retry", { name: "worker", scope: "Do focused work" }, undefined, undefined, context(f.leadSession));
    expect(retry.details).toMatchObject({ kind: "attention", reason: "launch_pending" }); expect(a.spawn).toHaveBeenCalledOnce();
  });

  it.each([false, true])("keeps the returned target after persistence fails (shell live: %s)", async alive => {
    const f = await team(`binding-failure-${alive}`); const a = adapter({ alive }); const tools = register(a.terminal);
    failNextTargetWrite("config write failed");
    const result = await tools.get("ensure_worker")!.execute("ensure", { name: "worker", scope: "Do focused work" }, undefined, undefined, context(f.leadSession));
    expect(result.details).toMatchObject({ kind: "worker_ensured", effect: "created", launch: "requested" });
    await settledLaunch(f.name, "unknown", "config write failed"); expect(a.kill).not.toHaveBeenCalled();
    expect(a.terminal.isAlive).not.toHaveBeenCalled();
    expect(await teams.currentMembership(f.name, "worker")).toMatchObject({ isActive: true, terminalTarget: { targetId: "pane-worker" } });
  });

  it("keeps shutdown agent content concise and the structured receipt in the machine envelope", async () => {
    vi.stubEnv("TMUX_PANE", ""); const f = await team("shutdown-receipt"); const tools = register(adapter().terminal);
    const result = await tools.get("team_shutdown")!.execute("shutdown", {}, undefined, undefined, context(f.leadSession));
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    expect(result.details).toMatchObject({ kind: "team_shutdown", lifecycle: "stopped", stopped_workers: [], unfinished_task_ids: [] });
  });

  it("reports partial shutdown once while preserving recovery evidence across projections", async () => {
    const f = await team("shutdown-partial-projection"); const tools = register(adapter({ alive: true }).terminal);
    await teams.ensureLogicalWorker(f.name, { name: "delivery-broken", scope: "Retain unfinished work across partial shutdown." });
    await teams.addMember(f.name, {
      membershipId: teams.newMembershipId(), agentId: `delivery-broken@${f.name}`, name: "delivery-broken", agentType: "teammate",
      joinedAt: Date.now(), tmuxPaneId: "pane-worker", sessionFile: `/tmp/${f.name}-delivery-broken.jsonl`, cwd: process.cwd(), subscriptions: [], isActive: true,
    });
    const applied = await tools.get("task_graph_apply")!.execute("shutdown-task", {
      operation_id: "shutdown-task",
      tasks: [{ key: "task-open", title: "Retained unfinished work", goal: "Keep this Task across partial shutdown.", assignee: "delivery-broken" }],
    }, undefined, undefined, context(f.leadSession));
    expect(applied.details).toMatchObject({ kind: "task_graph_applied", tasks_by_key: { "task-open": { status: "ready" } } });
    const result = await tools.get("team_shutdown")!.execute("shutdown-partial", { team_name: f.name }, undefined, undefined, context(f.leadSession));
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    expect(result.details).toMatchObject({ kind: "partial", lifecycle: "active", stopped_workers: [], failed_workers: ["delivery-broken"], unfinished_task_ids: ["task-open"], state_changed: true });
    expect(projectTui({ tool: "team_shutdown", details: result.details, expanded: false }).join("\n").length).toBeGreaterThan(0);
  });
});
