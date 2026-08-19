import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { clearAdapterCache, setAdapter } from "../adapters/terminal-registry";
import type { TerminalAdapter } from "./terminal-adapter";
import * as paths from "./paths";
import * as runtime from "./runtime";
import * as teams from "./teams";
import { BeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter";
import { projectTui } from "../../src/model-tool-contract/tui-projection";
import { DurableTeamLifecyclePublication } from "../adapters/durable-team-lifecycle-publication";
import { createWorkerLaunchBridge } from "./worker-launch-bridge";
import { materializeWorkerAggregate } from "./worker-resource-projection";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: any, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<any>;
};

const created: string[] = [];

function unique(suffix: string): string {
  const name = `launch-comp-${suffix}-${process.pid}-${Date.now()}-${created.length}`;
  created.push(name);
  return name;
}

function context(sessionFile: string, modelRegistry?: { getAvailable(): readonly { provider: string; id: string }[] }) {
  return {
    cwd: process.cwd(),
    ...(modelRegistry ? { modelRegistry } : {}),
    sessionManager: {
      getSessionFile: () => sessionFile,
      buildContextEntries: () => [],
    },
    ui: { setStatus() {}, notify() {} },
  };
}

function adapter(options: { alive?: boolean; name?: string } = {}) {
  const spawn = vi.fn(() => "pane-worker");
  const kill = vi.fn();
  const terminal: TerminalAdapter = {
    name: options.name ?? "launch-contract-terminal",
    isDirectCarrier: () => true,
    detect: () => true,
    spawn,
    kill,
    isAlive: vi.fn(() => options.alive ?? false),
    setTitle() {},
    supportsWindows: () => false,
    spawnWindow: () => "window-worker",
    setWindowTitle() {},
    killWindow() {},
    isWindowAlive: () => false,
  };
  return { terminal, spawn, kill };
}

function register(terminal: TerminalAdapter): Map<string, RegisteredTool> {
  setAdapter(terminal);
  const tools = new Map<string, RegisteredTool>();
  piTeams({
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
    on() {},
    sendUserMessage() {},
  } as never);
  return tools;
}

async function team(suffix: string, defaultModel?: string, terminalBackend = "launch-contract-terminal") {
  const name = unique(suffix);
  const leadSession = `/tmp/${name}-lead.jsonl`;
  const taskWorkspace = paths.teamDir(name);
  fs.mkdirSync(`${taskWorkspace}/.beads`, { recursive: true });
  fs.writeFileSync(`${taskWorkspace}/.beads/metadata.json`, JSON.stringify({
    database: "dolt",
    backend: "dolt",
    dolt_database: "launch_compensation_contract",
    project_id: `launch-compensation-${name}`,
  }));
  vi.spyOn(BeadsTaskAdapter.prototype, "list").mockResolvedValue([]);
  await teams.createTeam(
    name,
    leadSession,
    "lead",
    undefined,
    defaultModel,
    undefined,
    taskWorkspace,
    `task-authority-${name}`,
    {
      schema: "pi-teams-beads-authority/1",
      backend: "dolt",
      database: "dolt",
      doltDatabase: "launch_compensation_contract",
      projectId: `launch-compensation-${name}`,
    },
    undefined,
    { backend: terminalBackend, leadTarget: { backend: terminalBackend, kind: "pane", targetId: "pane-leader" } },
    undefined,
  );
  return { name, leadSession };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearAdapterCache();
  for (const name of created.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
});

describe("compensated Worker launch", () => {
  it("exposes a direct reusable prepared-launch service seam", async () => {
    const f = await team("bridge-seam");
    const a = adapter();
    setAdapter(a.terminal);
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: () => [],
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({ projectTrusted: false }),
      lifecyclePublication: new DurableTeamLifecyclePublication(),
    });
    const member = {
      membershipId: teams.newMembershipId(),
      pendingLaunchId: teams.newLaunchId(),
      agentId: `worker@${f.name}`,
      name: "worker",
      agentType: "teammate" as const,
      joinedAt: Date.now(),
      cwd: process.cwd(),
      subscriptions: [],
      isActive: true,
      prompt: "Own focused work.",
      color: "blue",
    };
    await teams.addMember(f.name, member);

    const launch = await bridge.launchPreparedMembership(
      f.name,
      member,
      null,
      () => ({ terminalId: "pane-worker", isWindow: false, backend: a.terminal.name }),
    );

    expect(launch).toEqual({ terminalId: "pane-worker", isWindow: false, backend: a.terminal.name });
    expect((await teams.currentMembership(f.name, "worker"))).toMatchObject({
      membershipId: member.membershipId,
      terminalTarget: { backend: "launch-contract-terminal", kind: "pane", targetId: "pane-worker" },
      isActive: true,
    });
  });

  it("compensates only a failed recovery target and leaves first Session admission to its child", async () => {
    const f = await team("recovery-persistence-failure");
    const a = adapter();
    setAdapter(a.terminal);
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: () => ["pi"],
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({ projectTrusted: false }),
      lifecyclePublication: new DurableTeamLifecyclePublication(),
    });
    const member = {
      membershipId: teams.newMembershipId(),
      pendingLaunchId: teams.newLaunchId(),
      agentId: `worker@${f.name}`,
      name: "worker",
      agentType: "teammate" as const,
      joinedAt: Date.now(),
      cwd: process.cwd(),
      subscriptions: [],
      isActive: true,
      prompt: "Own focused work.",
      color: "blue",
      terminalTarget: { backend: a.terminal.name, kind: "pane" as const, targetId: "dead-pane" },
    };
    await teams.addMember(f.name, member);
    vi.spyOn(teams, "updateMembership").mockRejectedValueOnce(new Error("recovery target write failed"));

    await expect(bridge.ensureWorker({ teamName: f.name, workerName: "worker", scope: "Own focused work.", cwd: process.cwd() }))
      .rejects.toThrow(/recovery target write failed.*exact recovery target was stopped/i);
    expect(a.kill).toHaveBeenCalledWith("pane-worker");
    expect(await teams.currentMembership(f.name, "worker")).toMatchObject({
      membershipId: member.membershipId,
      pendingLaunchId: member.pendingLaunchId,
      isActive: true,
    });
  });

  it("compensates a cancelled Herdr start after spawn", async () => {
    const f = await team("herdr-cancelled-start", undefined, "herdr");
    const a = adapter({ name: "herdr" });
    let live = false;
    a.spawn.mockImplementation(() => { live = true; return "pane-worker"; });
    a.kill.mockImplementation(() => { live = false; });
    a.terminal.isAlive = vi.fn(() => live);
    setAdapter(a.terminal);
    const cancelled = Object.assign(new Error("caller cancelled"), { name: "AbortError" });
    const lifecycle = new DurableTeamLifecyclePublication();
    vi.spyOn(lifecycle, "observeWorkerStartup").mockRejectedValue(cancelled);
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: () => ["pi"],
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({ projectTrusted: false }),
      lifecyclePublication: lifecycle,
    });
    const controller = new AbortController();
    controller.abort(cancelled);

    await expect(bridge.ensureWorker({ teamName: f.name, workerName: "worker", scope: "Own focused work.", cwd: process.cwd(), signal: controller.signal }))
      .rejects.toBe(cancelled);
    expect(a.kill).toHaveBeenCalledWith("pane-worker");
    expect((await teams.readConfig(f.name)).members.find((candidate) => candidate.name === "worker"))
      .toMatchObject({ isActive: false, deactivationReason: "replaced" });
  });

  it("does not stop a cancelled Herdr start after exact Session binding wins", async () => {
    const f = await team("herdr-cancelled-binding-race", undefined, "herdr");
    const a = adapter({ name: "herdr" });
    let live = false;
    a.spawn.mockImplementation(() => { live = true; return "pane-worker"; });
    a.terminal.isAlive = vi.fn(() => live);
    setAdapter(a.terminal);
    const cancelled = Object.assign(new Error("caller cancelled"), { name: "AbortError" });
    const lifecycle = new DurableTeamLifecyclePublication();
    vi.spyOn(lifecycle, "observeWorkerStartup").mockImplementation(async () => {
      const current = await teams.currentMembership(f.name, "worker");
      const startedAt = Date.now();
      await runtime.writeRuntimeStatus(f.name, "worker", {
        pid: process.pid,
        startedAt,
        lastHeartbeatAt: startedAt,
        ready: false,
      }, current.membershipId);
      await teams.bindMemberSession(f.name, "worker", "/tmp/herdr-cancelled-binding-race.jsonl", current.pendingLaunchId, {}, current.membershipId);
      throw cancelled;
    });
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: () => ["pi"],
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({ projectTrusted: false }),
      lifecyclePublication: lifecycle,
    });

    await expect(bridge.ensureWorker({ teamName: f.name, workerName: "worker", scope: "Own focused work.", cwd: process.cwd() }))
      .rejects.toBe(cancelled);
    expect(a.kill).not.toHaveBeenCalled();
    expect(await teams.currentMembership(f.name, "worker")).toMatchObject({
      sessionFile: "/tmp/herdr-cancelled-binding-race.jsonl",
    });
  });

  it("cleans and deactivates an unbound Herdr carrier after its bounded exact-binding observation", async () => {
    vi.stubEnv("PI_TEAMS_WORKER_STARTUP_WAIT_MS", "0");
    const f = await team("herdr-unbound-timeout", undefined, "herdr");
    const a = adapter({ name: "herdr" });
    let live = false;
    a.spawn.mockImplementation(() => { live = true; return "pane-worker"; });
    a.kill.mockImplementation(() => { live = false; });
    a.terminal.isAlive = vi.fn(() => live);
    setAdapter(a.terminal);
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: () => ["pi"],
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({ projectTrusted: false }),
      lifecyclePublication: new DurableTeamLifecyclePublication(),
    });

    await expect(bridge.ensureWorker({ teamName: f.name, workerName: "worker", scope: "Own focused work.", cwd: process.cwd() }))
      .rejects.toThrow(/Herdr start.*exact prepared Membership was deactivated/i);
    expect(a.kill).toHaveBeenCalledWith("pane-worker");
    const historical = (await teams.readConfig(f.name)).members.find((candidate) => candidate.name === "worker");
    expect(historical).toMatchObject({ isActive: false, deactivationReason: "replaced" });
  });

  it("cleans an unbound Herdr carrier before an exact retry creates a new carrier", async () => {
    const f = await team("herdr-unbound-retry", undefined, "herdr");
    const a = adapter({ name: "herdr" });
    const live = new Set<string>();
    a.spawn
      .mockImplementationOnce(() => { live.add("pane-first"); return "pane-first"; })
      .mockImplementationOnce(() => { live.add("pane-retry"); return "pane-retry"; });
    a.kill.mockImplementation((paneId: string) => { live.delete(paneId); });
    a.terminal.isAlive = vi.fn((paneId: string) => live.has(paneId));
    setAdapter(a.terminal);
    const lifecycle = new DurableTeamLifecyclePublication();
    vi.spyOn(lifecycle, "observeWorkerStartup")
      .mockResolvedValueOnce({ observed: false, carrier: "prepared", runtime: "not_observed", cursor: "1", reason: "timeout" })
      .mockResolvedValueOnce({ observed: true, carrier: "session_bound", runtime: "observed", cursor: "2" });
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: () => ["pi"],
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({ projectTrusted: false }),
      lifecyclePublication: lifecycle,
    });

    await expect(bridge.ensureWorker({ teamName: f.name, workerName: "worker", scope: "Own focused work.", cwd: process.cwd() }))
      .rejects.toThrow(/exact prepared Membership was deactivated/i);
    expect(live).toEqual(new Set());
    expect((await teams.readConfig(f.name)).members.filter((member) => member.agentType === "teammate")).toEqual([
      expect.objectContaining({ terminalTarget: { backend: "herdr", kind: "pane", targetId: "pane-first" }, isActive: false }),
    ]);

    await expect(bridge.ensureWorker({ teamName: f.name, workerName: "worker", scope: "Own focused work.", cwd: process.cwd() }))
      .resolves.toMatchObject({ action: "created", target: { terminalId: "pane-retry", backend: "herdr" } });
    expect(a.spawn).toHaveBeenCalledTimes(2);
    expect((await teams.readConfig(f.name)).members.filter((member) => member.agentType === "teammate" && member.isActive !== false)).toEqual([
      expect.objectContaining({ terminalTarget: { backend: "herdr", kind: "pane", targetId: "pane-retry" } }),
    ]);
  });

  it("refuses a live unbound Herdr carrier after cleanup cannot be confirmed", async () => {
    vi.stubEnv("PI_TEAMS_WORKER_STARTUP_WAIT_MS", "0");
    const f = await team("herdr-unbound-stop-unconfirmed", undefined, "herdr");
    const a = adapter({ name: "herdr", alive: true });
    setAdapter(a.terminal);
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: () => ["pi"],
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({ projectTrusted: false }),
      lifecyclePublication: new DurableTeamLifecyclePublication(),
    });

    await expect(bridge.ensureWorker({ teamName: f.name, workerName: "worker", scope: "Own focused work.", cwd: process.cwd() }))
      .rejects.toThrow(/process shutdown could not be confirmed/i);
    await expect(bridge.ensureWorker({ teamName: f.name, workerName: "worker", scope: "Own focused work.", cwd: process.cwd() }))
      .rejects.toThrow(/live terminal carrier before exact Session binding/i);
    expect(a.spawn).toHaveBeenCalledOnce();
    expect(a.kill).toHaveBeenCalledOnce();
  });

  it("does not stop a recovered Herdr target after exact Session binding wins the observation race", async () => {
    const f = await team("herdr-recovery-binding-race", undefined, "herdr");
    const a = adapter({ name: "herdr" });
    let live = false;
    a.spawn.mockImplementation(() => { live = true; return "pane-recovered"; });
    a.terminal.isAlive = vi.fn(() => live);
    setAdapter(a.terminal);
    const member = {
      membershipId: teams.newMembershipId(),
      pendingLaunchId: teams.newLaunchId(),
      agentId: `worker@${f.name}`,
      name: "worker",
      agentType: "teammate" as const,
      joinedAt: Date.now(),
      cwd: process.cwd(),
      subscriptions: [],
      isActive: true,
      terminalTarget: { backend: "herdr", kind: "pane" as const, targetId: "dead-pane" },
    };
    await teams.addMember(f.name, member);
    const lifecycle = new DurableTeamLifecyclePublication();
    vi.spyOn(lifecycle, "observeWorkerStartup").mockImplementation(async () => {
      const current = await teams.currentMembership(f.name, "worker");
      const startedAt = Date.now();
      await runtime.writeRuntimeStatus(f.name, "worker", {
        pid: process.pid,
        startedAt,
        lastHeartbeatAt: startedAt,
        ready: false,
      }, current.membershipId);
      await teams.bindMemberSession(f.name, "worker", "/tmp/herdr-recovery-race.jsonl", current.pendingLaunchId, {}, current.membershipId);
      return { observed: false, carrier: "prepared", runtime: "not_observed", cursor: "0", reason: "timeout" };
    });
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: () => ["pi"],
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({ projectTrusted: false }),
      lifecyclePublication: lifecycle,
    });

    await expect(bridge.ensureWorker({ teamName: f.name, workerName: "worker", scope: "Own focused work.", cwd: process.cwd() }))
      .resolves.toMatchObject({ action: "recovered", startup: { observed: false } });
    expect(a.kill).not.toHaveBeenCalled();
    expect(await teams.currentMembership(f.name, "worker")).toMatchObject({
      membershipId: member.membershipId,
      sessionFile: "/tmp/herdr-recovery-race.jsonl",
    });
  });

  it("refuses concurrent reuse of a live prepared recovery carrier", async () => {
    const f = await team("concurrent-recovery");
    const a = adapter();
    let recoveredTargetLive = false;
    a.spawn.mockImplementation(() => {
      recoveredTargetLive = true;
      return "pane-recovered";
    });
    a.terminal.isAlive = vi.fn(() => recoveredTargetLive);
    setAdapter(a.terminal);
    vi.stubEnv("PI_TEAMS_WORKER_STARTUP_WAIT_MS", "0");
    const firstAggregate = materializeWorkerAggregate({
      cwd: process.cwd(),
      policy: { appendGlobal: { path: "/fixture/first.md", content: "first" }, enable: [], disable: [], diagnostics: [] },
    })!;
    const staleEnsureAggregate = materializeWorkerAggregate({
      cwd: process.cwd(),
      policy: { appendGlobal: { path: "/fixture/stale.md", content: "stale" }, enable: [], disable: [], diagnostics: [] },
    })!;
    const aggregates = [firstAggregate, staleEnsureAggregate];
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: () => ["pi"],
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({ path: aggregates.shift(), projectTrusted: false }),
      lifecyclePublication: new DurableTeamLifecyclePublication(),
    });
    const member = {
      membershipId: teams.newMembershipId(),
      pendingLaunchId: teams.newLaunchId(),
      agentId: `worker@${f.name}`,
      name: "worker",
      agentType: "teammate" as const,
      joinedAt: Date.now(),
      cwd: process.cwd(),
      subscriptions: [],
      isActive: true,
      prompt: "Own focused work.",
      color: "blue",
      terminalTarget: { backend: a.terminal.name, kind: "pane" as const, targetId: "dead-pane" },
    };
    await teams.addMember(f.name, member);
    const withCurrentMembershipLease = teams.withCurrentMembershipLease;
    let leaseCalls = 0;
    let releaseFirstLease!: () => void;
    const secondEnsureReachedLease = new Promise<void>((resolve) => { releaseFirstLease = resolve; });
    vi.spyOn(teams, "withCurrentMembershipLease").mockImplementation(async (teamName, membershipId, action) => {
      if (++leaseCalls === 1) await secondEnsureReachedLease;
      else releaseFirstLease();
      return withCurrentMembershipLease(teamName, membershipId, action);
    });

    const outcomes = await Promise.allSettled([
      bridge.ensureWorker({ teamName: f.name, workerName: "worker", scope: "Own focused work.", cwd: process.cwd() }),
      bridge.ensureWorker({ teamName: f.name, workerName: "worker", scope: "Own focused work.", cwd: process.cwd() }),
    ]);

    expect(a.spawn).toHaveBeenCalledOnce();
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled").map((outcome) => (outcome as PromiseFulfilledResult<{ action: string }>).value.action)).toEqual(["recovered"]);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: expect.stringMatching(/live but not Session-bound/i) }) });
    const activeAggregate = (a.spawn.mock.calls as Array<Array<any>>)[0]?.[0]?.env.PI_TEAM_BRIGHT_WORKER_AGGREGATE;
    const unusedAggregate = [firstAggregate, staleEnsureAggregate].find((candidate) => candidate !== activeAggregate)!;
    expect(activeAggregate).toBeOneOf([firstAggregate, staleEnsureAggregate]);
    expect(fs.existsSync(activeAggregate)).toBe(true);
    expect(fs.existsSync(unusedAggregate)).toBe(false);
    fs.rmSync(activeAggregate, { force: true });
    expect(await teams.currentMembership(f.name, "worker")).toMatchObject({
      membershipId: member.membershipId,
      pendingLaunchId: member.pendingLaunchId,
      terminalTarget: { backend: a.terminal.name, kind: "pane", targetId: "pane-recovered" },
    });
  });

  it("passes only durable Team pane targets for first and later Workers", async () => {
    const f = await team("pane-placement");
    const a = adapter();
    a.spawn.mockReturnValueOnce("pane-worker-1").mockReturnValueOnce("pane-worker-2");
    setAdapter(a.terminal);
    vi.stubEnv("PI_TEAMS_WORKER_STARTUP_WAIT_MS", "0");
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: () => ["pi"],
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({ projectTrusted: false }),
      lifecyclePublication: new DurableTeamLifecyclePublication(),
    });

    await bridge.ensureWorker({ teamName: f.name, workerName: "worker-1", scope: "First area", cwd: process.cwd() });
    await bridge.ensureWorker({ teamName: f.name, workerName: "worker-2", scope: "Second area", cwd: process.cwd() });

    expect(a.spawn).toHaveBeenNthCalledWith(1, expect.objectContaining({
      panePlacement: { leaderPaneId: "pane-leader", workerPaneIds: [] },
    }));
    expect(a.spawn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      panePlacement: { leaderPaneId: "pane-leader", workerPaneIds: ["pane-worker-1"] },
    }));
  });

  it("captures a qualified Worker settings model before carrier creation and preserves explicit and Team defaults", async () => {
    const captured: Array<string | undefined> = [];
    const availableModelKeys = new Set(["setting/provider"]);
    const resolveSettingsModel = vi.fn((model: string, keys?: ReadonlySet<string>) => keys?.has(model) ? model : null);
    const a = adapter();
    a.spawn.mockReturnValueOnce("pane-settings").mockReturnValueOnce("pane-settings-retry").mockReturnValueOnce("pane-explicit").mockReturnValueOnce("pane-team").mockReturnValueOnce("pane-template");
    setAdapter(a.terminal);
    vi.stubEnv("PI_TEAMS_WORKER_STARTUP_WAIT_MS", "0");
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: (model) => {
        captured.push(model);
        return ["pi", ...(model ? ["--model", model] : [])];
      },
      resolveModel: (model) => `resolved/${model}`,
      resolveSettingsModel,
      workerAggregate: () => ({
        projectTrusted: false,
        defaultModel: { scope: "global", value: "setting/provider" },
      }),
      lifecyclePublication: new DurableTeamLifecyclePublication(),
    });

    const settingsTeam = await team("settings-model");
    const settingsWorker = await bridge.ensureWorker({
      teamName: settingsTeam.name, workerName: "settings", scope: "Settings model", cwd: process.cwd(), availableModelKeys,
    });
    expect(settingsWorker.member.model).toBe("setting/provider");
    expect(resolveSettingsModel).toHaveBeenCalledWith("setting/provider", availableModelKeys);
    const recoveredSettings = await bridge.ensureWorker({
      teamName: settingsTeam.name, workerName: "settings", scope: "Settings model", cwd: process.cwd(),
    });
    expect(recoveredSettings.action).toBe("recovered");
    expect(recoveredSettings.member.model).toBe("setting/provider");
    expect(resolveSettingsModel).toHaveBeenCalledOnce();

    const explicitWorker = await bridge.ensureWorker({
      teamName: settingsTeam.name, workerName: "explicit", scope: "Explicit model", cwd: process.cwd(), model: "explicit",
    });
    expect(explicitWorker.member.model).toBe("resolved/explicit");

    const teamDefault = await team("team-model", "team/default");
    const teamWorker = await bridge.ensureWorker({
      teamName: teamDefault.name, workerName: "team", scope: "Team model", cwd: process.cwd(),
    });
    expect(teamWorker.member.model).toBe("team/default");
    expect(resolveSettingsModel).toHaveBeenCalledOnce();

    const templateWorker = await bridge.ensureWorker({
      teamName: settingsTeam.name,
      workerName: "template",
      scope: "Template model",
      cwd: process.cwd(),
      availableModelKeys,
      initialMessage: async () => ({ id: "template-message", from: "lead", to: "template", text: "Template prompt", timestamp: new Date().toISOString(), read: false }),
    });
    expect(templateWorker.member.model).toBe("setting/provider");
    expect(captured).toEqual(expect.arrayContaining(["setting/provider", "resolved/explicit", "team/default"]));
    expect(captured.filter((model) => model === "setting/provider")).toHaveLength(3);
  });

  it("validates a first model-tool Worker default from its exact registry snapshot", async () => {
    const f = await team("model-registry-default");
    const a = adapter();
    vi.stubEnv("PI_AGENT_NAME", "");
    const tools = register(a.terminal);
    const agentDir = `${paths.teamDir(f.name)}/agent`;
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { default_model: "fixture/selected" } },
    }));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_TEAMS_WORKER_STARTUP_WAIT_MS", "0");
    const result = await tools.get("ensure_worker")!.execute(
      "ensure-model-registry-default",
      { name: "worker", scope: "Use the configured model." },
      undefined,
      undefined,
      context(f.leadSession, { getAvailable: () => [{ provider: "fixture", id: "selected" }] }),
    );

    expect(result.details).toMatchObject({ kind: "worker_ensured", effect: "created" });
    expect((await teams.currentMembership(f.name, "worker")).model).toBe("fixture/selected");
  });

  it("accepts a canonical nested Worker settings model and persists its exact ID", async () => {
    const f = await team("nested-settings-model");
    const a = adapter();
    setAdapter(a.terminal);
    vi.stubEnv("PI_TEAMS_WORKER_STARTUP_WAIT_MS", "0");
    const nested = "openrouter/openai/gpt-5.1";
    const argv = vi.fn((model: string | undefined) => ["pi", ...(model ? ["--model", model] : [])]);
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: argv,
      resolveModel: () => null,
      resolveSettingsModel: (model) => model === nested ? model : null,
      workerAggregate: () => ({ projectTrusted: false, defaultModel: { scope: "global", value: nested } }),
      lifecyclePublication: new DurableTeamLifecyclePublication(),
    });

    const worker = await bridge.ensureWorker({ teamName: f.name, workerName: "nested", scope: "Nested model", cwd: process.cwd() });
    expect(worker.member.model).toBe(nested);
    expect(argv).toHaveBeenCalledWith(nested, undefined, undefined, false);
  });

  it("keeps Pi's native default when no Worker, Team, or explicit model applies", async () => {
    const captured: Array<string | undefined> = [];
    const f = await team("native-model");
    const a = adapter();
    setAdapter(a.terminal);
    vi.stubEnv("PI_TEAMS_WORKER_STARTUP_WAIT_MS", "0");
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: (model) => {
        captured.push(model);
        return ["pi"];
      },
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({ projectTrusted: false }),
      lifecyclePublication: new DurableTeamLifecyclePublication(),
    });

    const worker = await bridge.ensureWorker({ teamName: f.name, workerName: "native", scope: "Native model", cwd: process.cwd() });
    expect(worker.member.model).toBeUndefined();
    expect(captured).toEqual([undefined]);
  });

  it("refuses an invalid Worker settings model before Membership or carrier creation", async () => {
    const f = await team("invalid-settings-model");
    const a = adapter();
    setAdapter(a.terminal);
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: () => ["pi"],
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({
        projectTrusted: false,
        defaultModel: { scope: "project", value: "bare-model" },
      }),
      lifecyclePublication: new DurableTeamLifecyclePublication(),
    });

    await expect(bridge.ensureWorker({
      teamName: f.name, workerName: "invalid", scope: "Invalid settings", cwd: process.cwd(),
    })).rejects.toThrow(/trusted project Pi settings.*qualified provider\/model.*Edit.*retry/i);
    expect(a.spawn).not.toHaveBeenCalled();
    expect((await teams.readConfig(f.name)).members.find((member) => member.name === "invalid")).toBeUndefined();
  });

  it("refuses an unavailable qualified Worker settings model before Membership or carrier creation", async () => {
    const f = await team("unavailable-settings-model");
    const a = adapter();
    setAdapter(a.terminal);
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: () => ["pi"],
      resolveModel: () => null,
      resolveSettingsModel: (model, keys) => keys?.has(model) ? model : null,
      workerAggregate: () => ({
        projectTrusted: false,
        defaultModel: { scope: "global", value: "missing/model" },
      }),
      lifecyclePublication: new DurableTeamLifecyclePublication(),
    });

    await expect(bridge.ensureWorker({
      teamName: f.name, workerName: "missing", scope: "Unavailable settings", cwd: process.cwd(), availableModelKeys: new Set(["known/model"]),
    })).rejects.toThrow(/global Pi settings.*missing\/model.*unavailable.*Edit.*retry/i);
    expect(a.spawn).not.toHaveBeenCalled();
    expect((await teams.readConfig(f.name)).members.find((member) => member.name === "missing")).toBeUndefined();
  });

  it("does not create a Worker carrier when Membership preparation persistence fails", async () => {
    const f = await team("preparation-failure");
    const a = adapter();
    const tools = register(a.terminal);
    vi.spyOn(teams, "addMember").mockRejectedValueOnce(new Error("membership write failed"));

    const refused = await tools.get("ensure_worker")!.execute(
      "ensure", { name: "worker", scope: "Do focused work" }, undefined, undefined, context(f.leadSession),
    );
    expect(refused.details).toMatchObject({ kind: "unavailable", reason: "carrier_unavailable" });
    expect(refused.details.message).toContain("membership write failed");

    expect(a.spawn).not.toHaveBeenCalled();
    const worker = (await teams.readConfig(f.name)).members.find((member) => member.name === "worker");
    expect(worker).toBeUndefined();
  });

  it("deactivates the exact prepared Membership when terminal launch fails before binding", async () => {
    const f = await team("terminal-launch-failure");
    const a = adapter();
    a.spawn.mockImplementationOnce(() => { throw new Error("terminal launch failed"); });
    const tools = register(a.terminal);

    const refused = await tools.get("ensure_worker")!.execute(
      "ensure", { name: "worker", scope: "Do focused work" }, undefined, undefined, context(f.leadSession),
    );
    expect(refused.details).toMatchObject({ kind: "unavailable", reason: "carrier_unavailable" });
    expect(refused.details.message).toMatch(/terminal launch failed.*deactivated/i);

    expect(a.kill).not.toHaveBeenCalled();
    const worker = (await teams.readConfig(f.name)).members.find((member) => member.name === "worker");
    expect(worker).toMatchObject({ isActive: false, deactivationReason: "replaced" });
  });

  it("kills and confirms the returned pane before deactivating after binding persistence fails", async () => {
    const f = await team("binding-failure");
    const a = adapter();
    const tools = register(a.terminal);
    vi.spyOn(teams, "updateMembership").mockRejectedValueOnce(new Error("config write failed"));

    const refused = await tools.get("ensure_worker")!.execute(
      "ensure", { name: "worker", scope: "Do focused work" }, undefined, undefined, context(f.leadSession),
    );
    expect(refused.details).toMatchObject({ kind: "unavailable", reason: "carrier_unavailable" });
    expect(refused.details.message).toMatch(/config write failed.*deactivated/i);

    expect(a.kill).toHaveBeenCalledWith("pane-worker");
    expect(a.terminal.isAlive).toHaveBeenCalledWith("pane-worker");
    const worker = (await teams.readConfig(f.name)).members.find((member) => member.name === "worker");
    expect(worker?.isActive).toBe(false);
  });

  it("retains the current Membership when pane shutdown cannot be confirmed", async () => {
    const f = await team("kill-noop");
    const a = adapter({ alive: true });
    const tools = register(a.terminal);
    vi.spyOn(teams, "updateMembership").mockRejectedValueOnce(new Error("config write failed"));

    const refused = await tools.get("ensure_worker")!.execute(
      "ensure", { name: "worker", scope: "Do focused work" }, undefined, undefined, context(f.leadSession),
    );
    expect(refused.details).toMatchObject({ kind: "unavailable", reason: "carrier_unavailable" });
    expect(refused.details.message).toMatch(/pane pane-worker.*remains current/i);

    expect(a.kill).toHaveBeenCalledWith("pane-worker");
    const worker = (await teams.readConfig(f.name)).members.find((member) => member.name === "worker");
    expect(worker?.isActive).not.toBe(false);
  });

  it("keeps shutdown agent content concise and the structured receipt in the machine envelope", async () => {
    vi.stubEnv("TMUX_PANE", "");
    const f = await team("shutdown-receipt");
    const a = adapter();
    const tools = register(a.terminal);

    const result = await tools.get("team_shutdown")!.execute(
      "shutdown",
      {},
      undefined,
      undefined,
      context(f.leadSession),
    );
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    expect(result.details).toMatchObject({
      kind: "team_shutdown",
      lifecycle: "stopped",
      stopped_workers: [],
      unfinished_task_ids: [],
    });
  });

  it("reports partial shutdown once while preserving recovery evidence across projections", async () => {
    const f = await team("shutdown-partial-projection");
    const a = adapter({ alive: true });
    const tools = register(a.terminal);
    await teams.addMember(f.name, {
      membershipId: teams.newMembershipId(),
      agentId: `delivery-broken@${f.name}`,
      name: "delivery-broken",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "pane-worker",
      sessionFile: `/tmp/${f.name}-delivery-broken.jsonl`,
      cwd: process.cwd(),
      subscriptions: [],
      isActive: true,
    });
    vi.mocked(BeadsTaskAdapter.prototype.list).mockResolvedValue([{
      id: "task-open",
      title: "Retained unfinished work",
      goal: "Keep this Task across partial shutdown.",
      current_context: "Work has not started.",
      status: "open",
      version: "v_0123456789abcdef",
    }]);

    const result = await tools.get("team_shutdown")!.execute(
      "shutdown-partial",
      { team_name: f.name },
      undefined,
      undefined,
      context(f.leadSession),
    );
    const agentText = result.content[0].text as string;

    expect(() => JSON.parse(agentText)).not.toThrow();
    expect(result.details).toMatchObject({
      kind: "partial",
      lifecycle: "active",
      stopped_workers: [],
      failed_workers: ["delivery-broken"],
      unfinished_task_ids: ["task-open"],
      state_changed: true,
    });

    const human = projectTui({
      tool: "team_shutdown",
      details: result.details,
      expanded: false,
    }).join("\n");
    expect(human.length).toBeGreaterThan(0);
  });
});
