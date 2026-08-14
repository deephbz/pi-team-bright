import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import piTeams from "../../extensions/index";
import { DurableModelToolTeamPort } from "../model-tool-contract/durable-model-tool-port";
import { DurableTaskOrchestration } from "../adapters/durable-task-orchestration";
import { DurableGraphTaskOrchestration } from "../task-authority/graph-orchestration";
import { clearAdapterCache, setAdapter } from "../adapters/terminal-registry";
import { TeamSessionLifecycleService } from "../team-authority/team-session-lifecycle-service";
import { DirectMessageDelivery } from "../alert-authority/direct-delivery";
import * as paths from "./paths";
import * as runtime from "./runtime";
import { SyncNudgeConductor } from "./sync-nudge-conductor";
import { TaskChangeDelivery } from "./task-delivery";
import * as teamEvents from "./team-events";
import * as teams from "./teams";

const createdTeams: string[] = [];

beforeAll(() => initTheme());

function teamName(suffix: string): string {
  const name = `pi-session-adapter-${suffix}-${process.pid}-${Date.now()}-${createdTeams.length}`;
  createdTeams.push(name);
  return name;
}

function terminal(name = "fake", titles: string[] = []) {
  return {
    name,
    detect: () => true,
    isDirectCarrier: () => true,
    currentTargetId: () => "pane-current",
    spawn: () => "pane-worker",
    kill() {},
    isAlive: () => true,
    setTitle: (title: string) => titles.push(title),
    supportsWindows: () => false,
    spawnWindow: () => { throw new Error("unused"); },
    setWindowTitle() {},
    killWindow() {},
    isWindowAlive: () => false,
  } as any;
}

function context(sessionFile: string) {
  return {
    mode: "tui",
    model: { id: "test", provider: "test", contextWindow: 10_000 },
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    shutdown: vi.fn(),
    sessionManager: {
      getSessionFile: vi.fn(() => sessionFile),
      getSessionId: vi.fn(() => `session-${sessionFile}`),
      getBranch: vi.fn(() => []),
      getEntries: vi.fn(() => []),
      buildContextEntries: vi.fn(() => []),
      getCwd: vi.fn(() => "/tmp/pi-team-bright-project"),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: { isUsingOAuth: vi.fn(() => false), getProvider: vi.fn(() => undefined) },
    getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 10_000, percent: 1 })),
    ui: { notify: vi.fn(), setStatus: vi.fn(), setFooter: vi.fn(), setTitle: vi.fn() },
  } as any;
}

function extension(activeTools = ["foreign_extension_tool", "team_create", "team_sync"]) {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const commands = new Map<string, { handler(args: string, ctx: any): Promise<void> }>();
  const registrations: string[] = [];
  let active = [...activeTools];
  const setActiveTools = vi.fn((names: string[]) => { active = [...names]; });
  piTeams({
    on(event: string, handler: (event: any, ctx: any) => Promise<void>) { handlers.set(event, handler); },
    registerCommand(name: string, command: { handler(args: string, ctx: any): Promise<void> }) { commands.set(name, command); },
    registerTool(tool: { name: string }) { registrations.push(tool.name); },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    getThinkingLevel: () => "high",
    getActiveTools: () => active,
    getAllTools: () => registrations.map((name) => ({ name })),
    setActiveTools,
  } as never);
  return Object.assign(handlers, { commands, registrations, setActiveTools });
}

async function createTeam(name: string, sessionFile: string) {
  return teams.createTeam(name, sessionFile, "lead-agent", "Session adapter characterization.");
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearAdapterCache();
  for (const name of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
});

describe("registered Pi Session adapter characterization", () => {
  it("recovers only the Worker tool surface and suppresses leader branch hooks", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("worker-recovery-surface");
    const sessionFile = `/tmp/${name}-worker.jsonl`;
    await createTeam(name, `/tmp/${name}-lead.jsonl`);
    await teams.addMember(name, {
      membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate",
      joinedAt: Date.now(), tmuxPaneId: "", sessionFile, cwd: process.cwd(), subscriptions: [],
    });
    const member = await teams.currentMembership(name, "worker");
    await runtime.writeRuntimeStatus(name, "worker", { pid: process.pid, startedAt: 1 }, member.membershipId);
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    const branchContext = vi.spyOn(DurableModelToolTeamPort.prototype, "setBranchContext");
    const ctx = context(sessionFile);
    const harness = extension();
    const registrationsBeforeRecovery = harness.registrations.length;

    await harness.get("session_start")!({ reason: "resume" }, ctx);
    await harness.get("tool_call")!({ toolName: "team_sync" }, ctx);
    await harness.get("before_provider_request")!({ payload: [] }, ctx);

    const workerTools = ["task_read", "task_update", "alert_send"];
    const leaderOnlyTools = ["team_create", "ensure_worker", "task_create", "team_sync", "worker_stop", "team_shutdown", "task_link"];
    const recoveredRegistrations = harness.registrations.slice(registrationsBeforeRecovery);
    expect(new Set(recoveredRegistrations)).toEqual(new Set(workerTools));
    expect(recoveredRegistrations).not.toEqual(expect.arrayContaining(leaderOnlyTools));
    expect(harness.setActiveTools).toHaveBeenLastCalledWith(["foreign_extension_tool", ...workerTools]);
    expect(branchContext).not.toHaveBeenCalled();
  });

  it("starts resumed already-current Worker deliveries in order without another admission mutation", async () => {
    vi.stubEnv("PI_AGENT_NAME", "worker");
    const name = teamName("worker-resume");
    vi.stubEnv("PI_TEAM_NAME", name);
    const sessionFile = `/tmp/${name}-worker.jsonl`;
    await createTeam(name, `/tmp/${name}-lead.jsonl`);
    await teams.addMember(name, {
      membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate",
      joinedAt: Date.now(), tmuxPaneId: "", sessionFile, cwd: process.cwd(), subscriptions: [],
    });
    const member = await teams.currentMembership(name, "worker");
    await runtime.writeRuntimeStatus(name, "worker", { pid: process.pid, startedAt: 1 }, member.membershipId);
    const order: string[] = [];
    const claim = vi.spyOn(runtime, "writeRuntimeStatus");
    const bind = vi.spyOn(teams, "bindMemberSession");
    const event = vi.spyOn(teamEvents, "appendTeamEvent");
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockImplementation(async () => { order.push("direct"); });
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockImplementation(async () => { order.push("task"); });
    vi.spyOn(DurableTaskOrchestration.prototype, "reconcileReady").mockImplementation(async () => {
      order.push("ready");
      return ["Task task-1 remains queued."];
    });

    const ctx = context(sessionFile);
    await extension().get("session_start")!({ reason: "resume" }, ctx);

    expect(order).toEqual(["direct", "task", "ready"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Pi Team Bright ready delivery: Task task-1 remains queued.", "warning");
    expect(claim).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
  });

  it.each(["legacy", "graph"] as const)("reconciles a ready Task that predates first Worker Session binding through the %s authority", async (authorityKind) => {
    vi.stubEnv("PI_AGENT_NAME", "worker");
    const name = teamName(`worker-first-binding-${authorityKind}`);
    vi.stubEnv("PI_TEAM_NAME", name);
    const sessionFile = `/tmp/${name}-worker.jsonl`;
    const membershipId = teams.newMembershipId();
    const launchId = teams.newLaunchId();
    vi.stubEnv("PI_TEAM_MEMBERSHIP_ID", membershipId);
    vi.stubEnv("PI_AGENT_LAUNCH_ID", launchId);
    const traceDirectory = fs.mkdtempSync(path.join("/tmp", "pi-team-session-ready-trace-"));
    const traceFile = path.join(traceDirectory, "trace.jsonl");
    vi.stubEnv("PI_TEAMS_TRACE_JSONL", traceFile);
    setAdapter(terminal());
    await createTeam(name, `/tmp/${name}-lead.jsonl`);
    await teams.addMember(name, {
      membershipId,
      pendingLaunchId: launchId,
      agentId: `worker@${name}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: process.cwd(),
      subscriptions: [],
    });

    const readyTaskId = `${authorityKind}-ready-before-binding`;
    const queuedTaskIds: string[] = [];
    const reconcile = vi.fn(async (teamName: string, worker?: string) => {
      if (teamName !== name) return [];
      const current = await teams.currentMembership(name, "worker");
      expect(current).toMatchObject({ membershipId, sessionFile });
      expect(worker).toBe("worker");
      queuedTaskIds.push(readyTaskId);
      return [];
    });
    const legacyReconciliation = vi.spyOn(DurableTaskOrchestration.prototype, "reconcileReady").mockImplementation(reconcile);
    const graphReconciliation = vi.spyOn(DurableGraphTaskOrchestration.prototype, "reconcileReady").mockImplementation(reconcile);
    vi.spyOn(DurableGraphTaskOrchestration.prototype, "hasGraph").mockImplementation((teamName) => authorityKind === "graph" && teamName === name);
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    const bind = vi.spyOn(teams, "bindMemberSession");

    await extension().get("session_start")!({ reason: "resume" }, context(sessionFile));

    expect(bind).toHaveBeenCalledWith(name, "worker", sessionFile, launchId, {}, membershipId);
    expect(queuedTaskIds).toEqual([readyTaskId]);
    if (authorityKind === "legacy") {
      expect(legacyReconciliation).toHaveBeenCalledWith(name, "worker");
      expect(graphReconciliation).not.toHaveBeenCalled();
    } else {
      expect(graphReconciliation).toHaveBeenCalledWith(name, "worker");
      expect(legacyReconciliation).not.toHaveBeenCalled();
    }
    const traces = fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(traces).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "worker_session_admission", teamName: name, workerName: "worker", outcome: "ok" }),
      expect.objectContaining({ operation: "worker_session_ready_reconciliation", teamName: name, workerName: "worker", outcome: "ok" }),
    ]));
    fs.rmSync(traceDirectory, { recursive: true, force: true });
  });

  it("admits a resumed lead before ordered deliveries and footer completion", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("lead-resume");
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    const config = await createTeam(name, sessionFile);
    const lead = config.members.find((member) => member.name === "team-lead")!;
    await runtime.writeRuntimeStatus(name, "team-lead", { pid: process.pid, startedAt: 1 }, lead.membershipId);
    const order: string[] = [];
    const admitLead = TeamSessionLifecycleService.prototype.admitLead;
    vi.spyOn(TeamSessionLifecycleService.prototype, "admitLead").mockImplementation(async function (this: TeamSessionLifecycleService, input: any) {
      order.push("admit");
      return admitLead.call(this, input);
    });
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockImplementation(async () => { order.push("direct"); });
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockImplementation(async () => { order.push("task"); });
    const ctx = context(sessionFile);
    ctx.ui.setFooter.mockImplementation(() => { order.push("footer"); });

    await extension().get("session_start")!({ reason: "resume" }, ctx);

    expect(order.indexOf("admit")).toBeLessThan(order.indexOf("direct"));
    expect(order).toContain("task");
    expect(order.indexOf("direct")).toBeLessThan(order.indexOf("task"));
    expect(order.indexOf("task")).toBeLessThan(order.lastIndexOf("footer"));
  });

  it("projects only public Team status and footer data through registered lifecycle and command hooks", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("projection-boundaries");
    const sessionFile = "/private/sessions/lead-secret.jsonl";
    const taskWorkspace = "/shown/task-workspace";
    const config = await createTeam(name, sessionFile);
    const lead = config.members[0];
    config.taskBackend = "beads";
    config.taskWorkspace = taskWorkspace;
    config.taskAuthorityId = "private-task-authority";
    config.taskAuthorityFingerprint = {
      schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt",
      doltDatabase: "private-database", projectId: "private-project",
    };
    config.members[0].tmuxPaneId = "%private-pane";
    teams.writeConfigAtomic(paths.configPath(name), config);
    await runtime.writeRuntimeStatus(name, "team-lead", { pid: process.pid, startedAt: 1 }, lead.membershipId);
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    const ctx = context(sessionFile);
    ctx.sessionManager.getCwd.mockReturnValue(taskWorkspace);
    const harness = extension();

    await harness.get("session_start")!({ reason: "resume" }, ctx);
    const footer = ctx.ui.setFooter.mock.calls.at(-1)?.[0];
    const component = footer({ requestRender: vi.fn() }, { fg: (_tone: string, text: string) => text }, {
      getGitBranch: () => "main", getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => undefined,
    });
    const footerText = component.render(140).join("\n");
    component.dispose();
    await harness.commands.get("pi-team-bright")!.handler("status", ctx);
    const statusText = ctx.ui.notify.mock.calls.at(-1)?.[0] as string;

    expect(statusText).toContain("Task authority: beads · degraded");
    expect(statusText).toContain(`Beads workspace: ${taskWorkspace}`);
    expect(footerText).toContain(taskWorkspace);
    for (const privateValue of [sessionFile, lead.membershipId!, "%private-pane"]) {
      expect(footerText).not.toContain(privateValue);
      expect(statusText).not.toContain(privateValue);
    }
    expect(ctx.ui.setFooter.mock.calls.map((call: unknown[]) => call[0])).toContain(undefined);
    expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
  });

  it("suppresses stale fork identity through the registered Session hook", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("fork-footer");
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    await createTeam(name, sessionFile);
    const ctx = context(sessionFile);
    const harness = extension();

    await harness.get("session_start")!({ reason: "fork" }, ctx);
    await harness.commands.get("pi-team-bright")!.handler("status", ctx);

    expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(undefined);
    expect(ctx.ui.setFooter.mock.calls.some((call: unknown[]) => typeof call[0] === "function")).toBe(false);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(/No current Team is bound/), "warning");
  });

  it("refuses an explicit missing Team before resumed identity, command, or delivery binding", async () => {
    vi.stubEnv("PI_AGENT_NAME", "worker");
    vi.stubEnv("PI_TEAM_NAME", `missing-${process.pid}`);
    const direct = vi.spyOn(DirectMessageDelivery.prototype, "start");
    const task = vi.spyOn(TaskChangeDelivery.prototype, "start");
    const ctx = context(`/tmp/missing-${process.pid}-worker.jsonl`);

    await expect(extension().get("session_start")!({ reason: "resume" }, ctx)).rejects.toThrow(/does not name a current team/i);

    expect(direct).not.toHaveBeenCalled();
    expect(task).not.toHaveBeenCalled();
  });

  it("uses the exact resumed Worker binding for delivery and preserves its profile prompt", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("worker-profile-binding");
    const sessionFile = `/tmp/${name}-worker.jsonl`;
    await createTeam(name, `/tmp/${name}-lead.jsonl`);
    await teams.addMember(name, {
      membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate",
      joinedAt: Date.now(), tmuxPaneId: "", sessionFile, cwd: process.cwd(), subscriptions: [],
      prompt: "Keep Task evidence exact.", model: "test/model", thinking: "high",
    });
    const member = await teams.currentMembership(name, "worker");
    await runtime.writeRuntimeStatus(name, "worker", { pid: process.pid, startedAt: 1 }, member.membershipId);
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    const bound = vi.spyOn(teams, "assertCurrentSessionBinding");
    const ctx = context(sessionFile);
    const handlers = extension();

    await handlers.get("session_start")!({ reason: "resume" }, ctx);
    const prompt = await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx) as any;

    expect(bound).toHaveBeenCalledWith(name, "worker", sessionFile);
    expect(prompt.systemPrompt).toContain("Your standing Worker profile: Keep Task evidence exact.");
    expect(prompt.systemPrompt).toContain("currently using model: test/model with thinking level: high");
  });

  it("keeps nudge actuation suppressed when the current Team policy disables it", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("nudge-policy-suppression");
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    const config = await createTeam(name, sessionFile);
    config.syncLiveness = { waitSeconds: 120, nudgeEnabled: false, nudgeDelaySeconds: 0, policyVersion: "characterization" };
    teams.writeConfigAtomic(paths.configPath(name), config);
    const start = vi.spyOn(SyncNudgeConductor.prototype, "start");
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);

    await extension().get("session_start")!({ reason: "resume" }, context(sessionFile));

    expect(start).not.toHaveBeenCalled();
  });

  it("keeps a resumed Worker alive when foreign placement refuses its Team binding", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    setAdapter(terminal("tmux"));
    const name = teamName("worker-refusal");
    const sessionFile = `/tmp/${name}-worker.jsonl`;
    const config = await createTeam(name, `/tmp/${name}-lead.jsonl`);
    config.terminalBackend = "herdr";
    teams.writeConfigAtomic(paths.configPath(name), config);
    await teams.addMember(name, {
      membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate",
      joinedAt: Date.now(), terminalTarget: { backend: "herdr", kind: "pane", targetId: "herdr-worker" },
      sessionFile, cwd: process.cwd(), subscriptions: [],
    });
    const direct = vi.spyOn(DirectMessageDelivery.prototype, "start");
    const task = vi.spyOn(TaskChangeDelivery.prototype, "start");
    const ctx = context(sessionFile);

    await extension().get("session_start")!({ reason: "resume" }, ctx);

    expect(direct).not.toHaveBeenCalled();
    expect(task).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/bound to terminal backend herdr/i), "error");
    expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(undefined);
    expect(ctx.shutdown).not.toHaveBeenCalled();
  });

  it("keeps a resumed lead alive when foreign placement refuses its Team binding", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    setAdapter(terminal("tmux"));
    const name = teamName("lead-refusal");
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    const config = await createTeam(name, sessionFile);
    config.terminalBackend = "herdr";
    config.members[0].terminalTarget = { backend: "herdr", kind: "pane", targetId: "herdr-pane" };
    teams.writeConfigAtomic(paths.configPath(name), config);
    const direct = vi.spyOn(DirectMessageDelivery.prototype, "start");
    const task = vi.spyOn(TaskChangeDelivery.prototype, "start");
    const nudge = vi.spyOn(SyncNudgeConductor.prototype, "start");
    const ctx = context(sessionFile);

    await extension().get("session_start")!({ reason: "resume" }, ctx);

    expect(direct).not.toHaveBeenCalled();
    expect(task).not.toHaveBeenCalled();
    expect(nudge).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/bound to terminal backend herdr/i), "error");
    expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(undefined);
    expect(ctx.shutdown).not.toHaveBeenCalled();
  });

  it("stops both deliveries and clears the footer on session shutdown", async () => {
    vi.stubEnv("PI_AGENT_NAME", "worker");
    const name = teamName("shutdown");
    vi.stubEnv("PI_TEAM_NAME", name);
    const sessionFile = `/tmp/${name}-worker.jsonl`;
    await createTeam(name, `/tmp/${name}-lead.jsonl`);
    await teams.addMember(name, {
      membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate",
      joinedAt: Date.now(), tmuxPaneId: "", sessionFile, cwd: process.cwd(), subscriptions: [],
    });
    const member = await teams.currentMembership(name, "worker");
    await runtime.writeRuntimeStatus(name, "worker", { pid: process.pid, startedAt: 1 }, member.membershipId);
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    const directStop = vi.spyOn(DirectMessageDelivery.prototype, "stop");
    const taskStop = vi.spyOn(TaskChangeDelivery.prototype, "stop");
    const ctx = context(sessionFile);
    const handlers = extension();
    await handlers.get("session_start")!({ reason: "resume" }, ctx);
    const footerCallsBeforeShutdown = ctx.ui.setFooter.mock.calls.length;
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);

    expect(directStop).toHaveBeenCalledOnce();
    expect(taskStop).toHaveBeenCalledOnce();
    expect(ctx.ui.setFooter.mock.calls.length).toBeGreaterThan(footerCallsBeforeShutdown);
    expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(undefined);
  });

  it("sets and refreshes Worker UI and terminal titles on the documented timer schedule", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PI_AGENT_NAME", "worker");
    const name = teamName("title");
    vi.stubEnv("PI_TEAM_NAME", name);
    const titles: string[] = [];
    setAdapter(terminal("fake", titles));
    const sessionFile = `/tmp/${name}-worker.jsonl`;
    await createTeam(name, `/tmp/${name}-lead.jsonl`);
    await teams.addMember(name, {
      membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate",
      joinedAt: Date.now(), tmuxPaneId: "", sessionFile, cwd: process.cwd(), subscriptions: [],
    });
    const member = await teams.currentMembership(name, "worker");
    await runtime.writeRuntimeStatus(name, "worker", { pid: process.pid, startedAt: 1 }, member.membershipId);
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    const ctx = context(sessionFile);
    const handlers = extension();

    await handlers.get("session_start")!({ reason: "resume" }, ctx);
    expect(ctx.ui.setTitle).toHaveBeenCalledWith(`${name}: worker`);
    expect(titles).toEqual([`${name}: worker`]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(titles).toEqual([`${name}: worker`, `${name}: worker`, `${name}: worker`, `${name}: worker`]);

    await handlers.get("turn_start")!({}, ctx);
    expect(ctx.ui.setTitle).toHaveBeenCalledTimes(5);
    expect(titles).toHaveLength(5);
  });
});
