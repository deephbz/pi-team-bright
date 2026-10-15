import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CarrierObserver } from "../carrier-observation";
import { nodeHostEnv, runWithHostEnv } from "../env/host-env";
import { projectStatusEntry } from "../model-tool-contract/custom-message-projection";
import { projectionLines } from "../model-tool-contract/tui-message-projection";
import { initTheme } from "@earendil-works/pi-coding-agent";
import piTeams from "../../extensions/index";
import { DurableModelToolTeamPort } from "../model-tool-contract/durable-model-tool-port";
import { DurableGraphTaskOrchestration } from "../task-authority/graph-orchestration";
import { clearAdapterCache, setAdapter } from "../adapters/terminal-registry";
import { TeamSessionLifecycleService } from "../team-authority/team-session-lifecycle-service";
import { TeamLifecycleService } from "../team-authority/team-lifecycle-service";
import { DirectMessageDelivery, DIRECT_MESSAGE_CUSTOM_TYPE } from "../alert-authority/direct-delivery";
import { sendAlert } from "../alert-authority/alerts";
import { DurableAlertMembership } from "../adapters/durable-alert-membership";
import { DurablePiSessionTeamQuery } from "../adapters/durable-pi-session-team-query";
import { UNSUPPORTED_BEADS_TEAM } from "../task-authority/graph-authority-errors";
import * as paths from "./paths";
import * as runtime from "./runtime";
import { SyncNudgeConductor } from "./sync-nudge-conductor";
import { TaskChangeDelivery } from "./task-delivery";
import * as teamEvents from "../coordination/event-journal";
import * as teams from "./teams";
import * as teamLabels from "./team-labels";

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
      getLeafId: vi.fn(() => null),
      getEntryCount: vi.fn(() => 0),
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
  // Binding characterization keeps explicit fixture names; naming has its own tests.
  vi.spyOn(teamLabels, "loadTeamDatePrefix").mockReturnValue(false);
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const commands = new Map<string, { handler(args: string, ctx: any): Promise<void> }>();
  const registrations: string[] = [];
  const tools = new Map<string, any>();
  let active = [...activeTools];
  const setActiveTools = vi.fn((names: string[]) => { active = [...names]; });
  const setSessionName = vi.fn();
  const appendEntry = vi.fn();
  const sendMessage = vi.fn(), sendUserMessage = vi.fn();
  piTeams({
    on(event: string, handler: (event: any, ctx: any) => Promise<void>) { handlers.set(event, handler); },
    registerCommand(name: string, command: { handler(args: string, ctx: any): Promise<void> }) { commands.set(name, command); },
    registerTool(tool: { name: string }) { registrations.push(tool.name); tools.set(tool.name, tool); },
    registerMessageRenderer() {},
    appendEntry,
    sendMessage,
    sendUserMessage,
    setSessionName,
    getThinkingLevel: () => "high",
    getActiveTools: () => active,
    getAllTools: () => registrations.map((name) => ({ name })),
    setActiveTools,
  } as never);
  return Object.assign(handlers, { commands, registrations, tools, setActiveTools, setSessionName, appendEntry, sendMessage, sendUserMessage });
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
  it("does no Herdr I/O at registration and fences shutdown during async startup detection", async () => {
    let finish!: (outcome: import("../env/host-env").ExecOutcome) => void;
    const run = vi.fn(() => new Promise<import("../env/host-env").ExecOutcome>(resolve => { finish = resolve; }));
    const runSync = vi.fn(() => { throw new Error("synchronous detection reached"); });
    const env = { ...nodeHostEnv, process: { ...nodeHostEnv.process, env: { ...nodeHostEnv.process.env,
      HERDR_ENV: "1", HERDR_PANE_ID: "synthetic-pane", HERDR_TAB_ID: "synthetic-tab", PI_TEAM_NAME: "", PI_AGENT_NAME: "" } },
      exec: { run, runSync } };
    await runWithHostEnv(env, async () => {
      const harness = extension();
      expect(run).not.toHaveBeenCalled(); expect(runSync).not.toHaveBeenCalled();
      const ctx = context("/tmp/synthetic-unbound-session.jsonl");
      const admission = vi.spyOn(TeamSessionLifecycleService.prototype, "admitLead");
      const startup = harness.get("session_start")!({ reason: "resume" }, ctx);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(run).toHaveBeenCalledOnce();
      await harness.get("session_shutdown")!({ reason: "quit" }, ctx);
      finish({ kind: "exited", status: 0, stdout: "running", stderr: "" });
      await startup;
      expect(admission).not.toHaveBeenCalled(); expect(runSync).not.toHaveBeenCalled();
      expect(harness.sendMessage).not.toHaveBeenCalled();
    });
  });
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
    await runtime.writeRuntimeStatus(name, "worker", { pid: process.pid, ...runtime.ownBirthIdentity(), startedAt: 1 }, member.membershipId);
    const order: string[] = [];
    const claim = vi.spyOn(runtime, "writeRuntimeStatus");
    const bind = vi.spyOn(teams, "bindMemberSession");
    const event = vi.spyOn(teamEvents, "appendTeamEvent");
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockImplementation(async () => { order.push("direct"); });
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockImplementation(async () => { order.push("task"); });
    vi.spyOn(DurableGraphTaskOrchestration.prototype, "reconcileReady").mockImplementation(async () => {
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

  it.each(["config", "directory"] as const)("stops unsupported Beads Task delivery once from %s evidence while presenting Alerts", async evidence => {
    vi.stubEnv("PI_AGENT_NAME", "worker");
    const name = teamName(`unsupported-${evidence}`);
    vi.stubEnv("PI_TEAM_NAME", name);
    const sessionFile = `/tmp/${name}-worker.jsonl`;
    await createTeam(name, `/tmp/${name}-lead.jsonl`);
    await teams.addMember(name, {
      membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate",
      joinedAt: Date.now(), tmuxPaneId: "", sessionFile, cwd: process.cwd(), subscriptions: [],
    });
    const member = await teams.currentMembership(name, "worker");
    await runtime.writeRuntimeStatus(name, "worker", { pid: process.pid, ...runtime.ownBirthIdentity(), startedAt: 1 }, member.membershipId);
    fs.rmSync(path.dirname(paths.graphTaskAuthorityPath(name)), { recursive: true });
    if (evidence === "config") {
      const config = JSON.parse(fs.readFileSync(paths.configPath(name), "utf8"));
      fs.writeFileSync(paths.configPath(name), JSON.stringify({ ...config, taskBackend: "beads" }));
    } else fs.mkdirSync(path.join(paths.teamDir(name), ".beads"));
    const accepted = await sendAlert({ teamName: name, from: "team-lead", to: "worker", kind: "attention", text: "Alert survives unsupported Task storage." },
      new DurableAlertMembership(), { appendAcceptedAlert: async () => ({ cursor: "0" }) });
    expect(accepted.accepted).toHaveLength(1);
    if (evidence === "directory") await new TeamSessionLifecycleService({} as never).writeDeliveryState({
      teamName: name, recipient: "worker", membershipId: member.membershipId!, sessionFile,
    }, "task", { state: "degraded", engine: "task", operation: "start", message: "Earlier transient failure", observedAt: Date.now(), retryAt: Date.now() + 1000 }, () => true);
    const taskStart = vi.spyOn(TaskChangeDelivery.prototype, "start");
    const directStart = vi.spyOn(DirectMessageDelivery.prototype, "start");
    vi.useFakeTimers();
    const ctx = context(sessionFile), harness = extension();
    await harness.get("session_start")!({ reason: "resume" }, ctx);
    expect(harness.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: DIRECT_MESSAGE_CUSTOM_TYPE, content: expect.stringContaining("Alert survives unsupported Task storage.") }), expect.objectContaining({ triggerTurn: true }));
    const state = (await runtime.readRuntimeStatus(name, "worker"))?.delivery?.engines.task;
    expect(state).toMatchObject({ state: "degraded", operation: "start", message: UNSUPPORTED_BEADS_TEAM });
    expect(state).not.toHaveProperty("retryAt");
    await vi.advanceTimersByTimeAsync(61000);
    expect(taskStart).toHaveBeenCalledOnce();
    expect(directStart).toHaveBeenCalledOnce();
    expect(ctx.ui.notify.mock.calls.filter(([text]: [string]) => text.startsWith("Task delivery"))).toEqual([[`Task delivery stopped: ${UNSUPPORTED_BEADS_TEAM} It will not retry. Finish this Team with its original PTB version or start a new Team.`, "warning"]]);
    await harness.get("session_shutdown")!({ reason: "quit" }, ctx);
  });

  it.each(["retry", "reload"] as const)("toasts once per delivery episode across %s recovery while persisting each retry", async recovery => {
    vi.stubEnv("PI_AGENT_NAME", "worker");
    const name = teamName("delivery-episodes");
    vi.stubEnv("PI_TEAM_NAME", name);
    const sessionFile = `/tmp/${name}-worker.jsonl`;
    await createTeam(name, `/tmp/${name}-lead.jsonl`);
    await teams.addMember(name, {
      membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate",
      joinedAt: Date.now(), tmuxPaneId: "", sessionFile, cwd: process.cwd(), subscriptions: [],
    });
    const member = await teams.currentMembership(name, "worker");
    await runtime.writeRuntimeStatus(name, "worker", { pid: process.pid, ...runtime.ownBirthIdentity(), startedAt: 1 }, member.membershipId);
    vi.useFakeTimers();
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    const start = vi.spyOn(TaskChangeDelivery.prototype, "start")
      .mockRejectedValueOnce(new Error("storage fault"))
      .mockRejectedValueOnce(new Error("storage fault"))
      .mockRejectedValueOnce(new Error("storage fault"))
      .mockResolvedValue(undefined);
    vi.spyOn(DurableGraphTaskOrchestration.prototype, "reconcileReady").mockResolvedValue([]);
    const publish = vi.spyOn(TeamSessionLifecycleService.prototype, "writeDeliveryState");
    const ctx = context(sessionFile), harness = extension();
    await harness.get("session_start")!({ reason: "resume" }, ctx);
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    const notices = () => ctx.ui.notify.mock.calls.filter(([text]: [string]) => /^Task delivery (is degraded|recovered)/.test(text));
    expect(start).toHaveBeenCalledTimes(3);
    expect(notices()).toEqual([["Task delivery is degraded: storage fault. Retry is scheduled.", "warning"]]);
    await vi.waitFor(() => expect(publish.mock.calls.filter(([, engine, state]) => engine === "task" && state.state === "degraded")).toHaveLength(3), { timeout: 1000, interval: 1 });
    await Promise.all(publish.mock.results.map(result => result.value));
    const failures = publish.mock.calls.filter(([, engine, state]) => engine === "task" && state.state === "degraded");
    expect(new Set(failures.map(([, , state]) => state.state === "degraded" && state.retryAt)).size).toBe(3);
    expect((await runtime.readRuntimeStatus(name, "worker"))?.delivery?.engines.task).toEqual(failures[2][2]);
    if (recovery === "retry") await vi.advanceTimersByTimeAsync(4000);
    else await harness.get("session_start")!({ reason: "reload" }, ctx);
    await vi.waitFor(() => expect(notices()).toHaveLength(2), { timeout: 1000, interval: 1 });
    await Promise.all(publish.mock.results.map(result => result.value));
    expect(notices()[1]).toEqual(["Task delivery recovered.", "info"]);
    expect((await runtime.readRuntimeStatus(name, "worker"))?.delivery?.engines.task?.state).toBe("running");
    vi.spyOn(TaskChangeDelivery.prototype, "observeContext").mockRejectedValueOnce(new Error("second fault"));
    await harness.get("context")!({ messages: [] }, ctx);
    expect(notices()).toHaveLength(3);
    expect(notices()[2]).toEqual(["Task delivery is degraded: second fault. Retry is scheduled.", "warning"]);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(notices()).toHaveLength(4), { timeout: 1000, interval: 1 });
    await Promise.all(publish.mock.results.map(result => result.value));
    expect(notices()[3]).toEqual(["Task delivery recovered.", "info"]);
    await harness.get("session_shutdown")!({ reason: "quit" }, ctx);
  });

  it("reconciles a ready graph Task that predates first Worker Session binding", async () => {
    vi.stubEnv("PI_AGENT_NAME", "worker");
    const name = teamName("worker-first-binding-graph");
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
      membershipId, pendingLaunchId: launchId, agentId: `worker@${name}`, name: "worker", agentType: "teammate",
      joinedAt: Date.now(), tmuxPaneId: "", cwd: process.cwd(), subscriptions: [],
    });

    const readyTaskId = "graph-ready-before-binding";
    const queuedTaskIds: string[] = [];
    const reconcile = vi.fn(async (teamName: string, worker?: string) => {
      if (teamName !== name) return [];
      const current = await teams.currentMembership(name, "worker");
      expect(current).toMatchObject({ membershipId, sessionFile });
      expect(worker).toBe("worker");
      queuedTaskIds.push(readyTaskId);
      return [];
    });
    const graphReconciliation = vi.spyOn(DurableGraphTaskOrchestration.prototype, "reconcileReady").mockImplementation(reconcile);
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    const bind = vi.spyOn(teams, "bindMemberSession");

    await extension().get("session_start")!({ reason: "resume" }, context(sessionFile));

    expect(bind).toHaveBeenCalledWith(name, "worker", sessionFile, launchId, {}, membershipId);
    expect(queuedTaskIds).toEqual([readyTaskId]);
    expect(graphReconciliation).toHaveBeenCalledWith(name, "worker");
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
    const config = await createTeam(name, sessionFile);
    const lead = config.members[0];
    config.members[0].tmuxPaneId = "%private-pane";
    teams.writeConfigAtomic(paths.configPath(name), config);
    await runtime.writeRuntimeStatus(name, "team-lead", { pid: process.pid, startedAt: 1 }, lead.membershipId);
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    const ctx = context(sessionFile);
    const harness = extension();

    await harness.get("session_start")!({ reason: "resume" }, ctx);
    const footer = ctx.ui.setFooter.mock.calls.at(-1)?.[0];
    const component = footer({ requestRender: vi.fn() }, { fg: (_tone: string, text: string) => text }, {
      getGitBranch: () => "main", getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => undefined,
    });
    const footerText = component.render(140).join("\n");
    component.dispose();
    await harness.commands.get("pi-team-bright")!.handler("status", ctx);
    const statusText = harness.appendEntry.mock.calls.find(call => call[0] === "ptb.status")?.[1].lines.join("\n") as string;

    expect(statusText).not.toMatch(/Beads|Dolt|task authority: beads/i);
    for (const privateValue of [sessionFile, lead.membershipId!, "%private-pane"]) {
      expect(footerText).not.toContain(privateValue);
      expect(statusText).not.toContain(privateValue);
    }
    expect(ctx.ui.setFooter.mock.calls.map((call: unknown[]) => call[0])).toContain(undefined);
    expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
  });

  it("presents one durable status and remembers a batched adoption decline in the exact Session", async () => {
    vi.stubEnv("PI_AGENT_NAME", ""); vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("batched-status"); const sessionFile = `/tmp/${name}-lead.jsonl`;
    const config = await createTeam(name, sessionFile);
    await runtime.writeRuntimeStatus(name, "team-lead", { pid: process.pid, startedAt: 1 }, config.members[0].membershipId);
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(CarrierObserver.prototype, "start").mockImplementation(() => {});
    vi.spyOn(CarrierObserver.prototype, "refresh").mockResolvedValue(undefined);
    vi.spyOn(CarrierObserver.prototype, "views", "get").mockReturnValue(new Map(["one", "two", "stopped", "absent"].map(worker => [worker, {
      worker, membership: worker, generation: { pid: 42, startedAt: 1, membershipId: worker }, process: "unknown", launch: "none", terminal: "present", activity: "unknown", paneId: `pane-${worker}`, evidence: [],
      ...(worker === "absent" ? { processSample: { pid: 42, probe: { kind: "absent" } } } : {}),
      ...(worker === "stopped" ? { lastStop: { piReason: "quit", observedAt: 1, suspectedHumanStop: true } } : {}),
    }])) as any);
    const ctx = context(sessionFile); ctx.ui.confirm = vi.fn().mockResolvedValue(false);
    const harness = extension(); await harness.get("session_start")!({ reason: "resume" }, ctx);
    ctx.ui.notify.mockClear();
    await harness.commands.get("pi-team-bright")!.handler("status", ctx);
    await harness.commands.get("pi-team-bright")!.handler("status", ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(ctx.ui.confirm.mock.calls[0][1]).toContain("one: pane pane-one");
    expect(ctx.ui.confirm.mock.calls[0][1]).toContain("two: pane pane-two");
    expect(ctx.ui.confirm.mock.calls[0][1]).not.toContain("stopped");
    expect(ctx.ui.confirm.mock.calls[0][1]).not.toContain("absent");
    const entries = harness.appendEntry.mock.calls.filter(call => call[0] === "ptb.status");
    expect(entries).toHaveLength(2); expect(entries[0][1].lines).toHaveLength(5);
    expect(entries[0][1].lines[3]).toContain("lastStop=quit; suspectedHumanStop=true; nonterminalTaskIds=");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    ctx.sessionManager.getSessionFile.mockReturnValue("/tmp/other-lead.jsonl");
    await harness.commands.get("pi-team-bright")!.handler("status", ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledOnce();
  });

  it("shows decisive unknown carrier facts in status with full facts in expandable detail", async () => {
    vi.stubEnv("PI_AGENT_NAME", ""); vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("unknown-facts"), sessionFile = `/tmp/${name}-lead.jsonl`;
    const config = await createTeam(name, sessionFile);
    await runtime.writeRuntimeStatus(name, "team-lead", { pid: process.pid, startedAt: 1 }, config.members[0].membershipId);
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(CarrierObserver.prototype, "start").mockImplementation(() => {});
    vi.spyOn(CarrierObserver.prototype, "refresh").mockResolvedValue(undefined);
    const launchFact = `timeout: timed out waiting for agent startup ${"detail ".repeat(40)}`;
    vi.spyOn(CarrierObserver.prototype, "views", "get").mockReturnValue(new Map([["worker", {
      worker: "worker", membership: "m", process: "unknown", launch: "unknown", terminal: "present", activity: "unknown", paneId: "pane",
      evidence: [{ source: "process_generation", fact: "generation_helper_missing", observedAt: 1 }, { source: "launch", fact: launchFact, observedAt: 1 }],
    }]]) as any);
    const ctx = context(sessionFile), harness = extension();
    await harness.get("session_start")!({ reason: "resume" }, ctx);
    harness.appendEntry.mockClear(); harness.sendMessage.mockClear(); harness.sendUserMessage.mockClear();
    await harness.commands.get("ptb")!.handler("status", ctx);
    const data = harness.appendEntry.mock.calls.find(call => call[0] === "ptb.status")![1];
    expect(data.lines[1]).toContain("process unknown (generation_helper_missing); launch unknown (timeout: timed out waiting for agent startup");
    expect(data.lines[1]).not.toContain(launchFact);
    expect(data.carrierFacts).toEqual([{ worker: "worker", process: "generation_helper_missing", launch: launchFact }]);
    expect(projectionLines(projectStatusEntry(data)!, { expanded: true }).join("\n")).toContain(launchFact);
    expect(harness.sendMessage).not.toHaveBeenCalled(); expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux"] as const)("warns once per extension load about a missing helper only on macOS (%s), without model history", async platform => {
    vi.stubEnv("PI_AGENT_NAME", ""); vi.stubEnv("PI_TEAM_NAME", "");
    await runWithHostEnv({ ...nodeHostEnv, process: { ...nodeHostEnv.process, platform,
      generation: () => ({ kind: "unknown", reason: "generation_helper_missing" }) } }, async () => {
      const ctx = context("/tmp/helper-warning-session.jsonl"), harness = extension();
      await harness.get("session_start")!({ reason: "fork" }, ctx);
      await harness.get("session_start")!({ reason: "fork" }, ctx);
      const warnings = ctx.ui.notify.mock.calls.filter((call: unknown[]) => String(call[0]).includes("process-generation helper"));
      expect(warnings).toHaveLength(platform === "darwin" ? 1 : 0);
      if (platform === "darwin") {
        expect(warnings[0]).toEqual([expect.stringMatching(/rustc.*Xcode Command Line Tools.*npm run build:process-generation/), "warning"]);
        const reloaded = extension(); await reloaded.get("session_start")!({ reason: "fork" }, ctx);
        expect(ctx.ui.notify.mock.calls.filter((call: unknown[]) => String(call[0]).includes("process-generation helper"))).toHaveLength(2);
      }
      expect(harness.appendEntry).not.toHaveBeenCalled(); expect(harness.sendMessage).not.toHaveBeenCalled(); expect(harness.sendUserMessage).not.toHaveBeenCalled();
    });
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

  it.each(["start", "fork"])("binds deliveries only after explicit %s Team creation", async (reason) => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName(`explicit-${reason}-create`);
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    const directStart = vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    const taskStart = vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    setAdapter(terminal());
    const ctx = context(sessionFile);
    const harness = extension();

    await harness.get("session_start")!({ reason }, ctx);
    expect(directStart).not.toHaveBeenCalled();
    expect(taskStart).not.toHaveBeenCalled();

    const result = await harness.tools.get("team_create").execute("create", { name, purpose: "registered adapter lifecycle proof" }, undefined, undefined, ctx);

    expect(result.details).toMatchObject({ kind: "team_created", team: { name } });
    expect(directStart).toHaveBeenCalledOnce();
    expect(taskStart).toHaveBeenCalledOnce();
    expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
  });

  it("cleans the registered pair and identity after full shutdown", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("full");
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    setAdapter(terminal());
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    const directStop = vi.spyOn(DirectMessageDelivery.prototype, "stop");
    const taskStop = vi.spyOn(TaskChangeDelivery.prototype, "stop");
    vi.spyOn(TeamLifecycleService.prototype, "shutdownTeam").mockResolvedValue({ kind: "shutdown", stoppedWorkers: [], unfinishedTaskIds: [] });
    const ctx = context(sessionFile);
    const harness = extension();

    await harness.get("session_start")!({ reason: "start" }, ctx);
    const created = await harness.tools.get("team_create").execute("create", { name, purpose: "full shutdown proof" }, undefined, undefined, ctx);
    expect(created.details).toMatchObject({ kind: "team_created", team: { name } });
    const shutdown = await harness.tools.get("team_shutdown").execute("shutdown", {}, undefined, undefined, ctx);

    expect(shutdown.details).toMatchObject({ kind: "team_shutdown" });
    expect(directStop).toHaveBeenCalledOnce();
    expect(taskStop).toHaveBeenCalledOnce();
    expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(undefined);
  });

  it("retains the registered pair and footer after partial shutdown", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("partial");
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    setAdapter(terminal());
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    const directStop = vi.spyOn(DirectMessageDelivery.prototype, "stop");
    const taskStop = vi.spyOn(TaskChangeDelivery.prototype, "stop");
    vi.spyOn(TeamLifecycleService.prototype, "shutdownTeam").mockResolvedValue({ kind: "partial", stoppedWorkers: [], failedWorkers: ["worker"], unfinishedTaskIds: [] });
    const ctx = context(sessionFile);
    const harness = extension();

    await harness.get("session_start")!({ reason: "start" }, ctx);
    await harness.tools.get("team_create").execute("create", { name, purpose: "partial shutdown proof" }, undefined, undefined, ctx);
    const shutdown = await harness.tools.get("team_shutdown").execute("shutdown", {}, undefined, undefined, ctx);

    expect(shutdown.details).toMatchObject({ kind: "partial", lifecycle: "active" });
    expect(directStop).not.toHaveBeenCalled();
    expect(taskStop).not.toHaveBeenCalled();
    expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
  });

  it("cleans refused registered lead admission and preserves post-commit create failure", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("create-admission-refusal");
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    vi.spyOn(TeamSessionLifecycleService.prototype, "admitLead").mockResolvedValue({ kind: "refused", reason: "lead admission refused", exitProcess: false });
    const directStart = vi.spyOn(DirectMessageDelivery.prototype, "start");
    const taskStart = vi.spyOn(TaskChangeDelivery.prototype, "start");
    setAdapter(terminal());
    const ctx = context(sessionFile);
    const harness = extension();

    await harness.get("session_start")!({ reason: "start" }, ctx);
    const result = await harness.tools.get("team_create").execute("create", { name, purpose: "refused admission proof" }, undefined, undefined, ctx);

    expect(result.details).toMatchObject({ kind: "unavailable", reason: "team_authority_unavailable" });
    expect(directStart).not.toHaveBeenCalled();
    expect(taskStart).not.toHaveBeenCalled();
    expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(undefined);
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

  it("preserves the exact resumed Worker binding and stable prompt across model and thinking changes", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("worker-profile-binding");
    const sessionFile = `/tmp/${name}-worker.jsonl`;
    await createTeam(name, `/tmp/${name}-lead.jsonl`);
    await teams.addMember(name, {
      membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate",
      joinedAt: Date.now(), tmuxPaneId: "", sessionFile, cwd: process.cwd(), subscriptions: [],
      prompt: "Keep Task evidence exact.", model: "test/model", thinking: "high",
      modelProfile: { alias: "fixture-model-role", provider: "test", model: "model", thinking: "high" },
    });
    const member = await teams.currentMembership(name, "worker");
    await runtime.writeRuntimeStatus(name, "worker", { pid: process.pid, startedAt: 1 }, member.membershipId);
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    const bound = vi.spyOn(teams, "assertCurrentSessionBinding");
    const ctx = context(sessionFile);
    const handlers = extension();

    await handlers.get("session_start")!({ reason: "resume" }, ctx);
    ctx.thinkingLevel = "high";
    const prompt = await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx) as any;

    expect(bound).toHaveBeenCalledWith(name, "worker", sessionFile);
    expect(prompt.systemPrompt).toContain("Your standing Worker profile: Keep Task evidence exact.");
    expect(prompt.systemPrompt).toContain(`You are Worker 'worker' on Team '${name}'.`);
    expect(prompt.systemPrompt).toContain("Your lead is 'team-lead'.");
    expect(prompt.systemPrompt).toContain("Assigned Tasks are your work contracts.");

    ctx.model = { ...ctx.model, provider: "changed-provider", id: "changed-model" };
    const afterModelChange = await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx) as any;
    expect(afterModelChange.systemPrompt).toBe(prompt.systemPrompt);

    ctx.thinkingLevel = "low";
    const afterThinkingChange = await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx) as any;
    expect(afterThinkingChange.systemPrompt).toBe(prompt.systemPrompt);
    for (const text of ["test/model", "fixture-model-role", "test/test", "changed-provider", "changed-model", "high", "low", "thinking level", "model assignment", "model selection"]) {
      expect(prompt.systemPrompt).not.toContain(text);
    }
  });

  it.each(["read failure between runs", "profile change mid-Session", "first-read failure then success"])("captures the Worker prompt per Session: %s", async (scenario) => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("worker-prompt-capture");
    const sessionFile = `/tmp/${name}-worker.jsonl`;
    await createTeam(name, `/tmp/${name}-lead.jsonl`);
    await teams.addMember(name, {
      membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate",
      joinedAt: Date.now(), tmuxPaneId: "", sessionFile, cwd: process.cwd(), subscriptions: [],
      prompt: "Keep Task evidence exact.",
    });
    const member = await teams.currentMembership(name, "worker");
    await runtime.writeRuntimeStatus(name, "worker", { pid: process.pid, startedAt: 1 }, member.membershipId);
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    let unavailable = scenario === "first-read failure then success";
    let profile = "Keep Task evidence exact.";
    const query = vi.spyOn(DurablePiSessionTeamQuery.prototype, "workerProfile").mockImplementation(async () => {
      if (unavailable) throw new Error("Temporary profile read failure");
      return { prompt: profile };
    });
    const ctx = context(sessionFile);
    const handlers = extension();
    await handlers.get("session_start")!({ reason: "resume" }, ctx);
    const run = async () => (await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx) as any).systemPrompt;
    const first = await run();

    if (scenario === "first-read failure then success") {
      expect(first).not.toContain("Your standing Worker profile:");
      unavailable = false;
      const captured = await run();
      expect(captured).toContain("Your standing Worker profile: Keep Task evidence exact.");
      expect(await run()).toBe(captured);
      expect(query).toHaveBeenCalledTimes(2);
    } else {
      expect(first).toContain("Your standing Worker profile: Keep Task evidence exact.");
      if (scenario === "read failure between runs") unavailable = true;
      else profile = "Use the revised standing profile.";
      expect(await run()).toBe(first);
      unavailable = false;
      expect(await run()).toBe(first);
      expect(query).toHaveBeenCalledTimes(1);
      if (scenario === "profile change mid-Session") {
        await handlers.get("session_start")!({ reason: "resume" }, ctx);
        expect(await run()).toContain("Your standing Worker profile: Use the revised standing profile.");
        expect(query).toHaveBeenCalledTimes(2);
      }
    }
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

  it("never chooses a leader Session name and releases with only the current name", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const titles: string[] = [];
    setAdapter(terminal("fake", titles));
    const name = teamName("leader-title");
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    const config = await createTeam(name, sessionFile);
    await runtime.writeRuntimeStatus(name, "team-lead", { pid: process.pid, startedAt: 1 }, config.members[0].membershipId);
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue(undefined);
    const ctx = context(sessionFile);
    const handlers = extension();
    handlers.setSessionName.mockImplementation((label: string) => {
      ctx.sessionManager.getSessionName.mockReturnValue(label);
      // Pi's synchronous session_info_changed listener owns this decoration.
      ctx.ui.setTitle(`native-default:${label}`);
    });
    await handlers.get("session_start")!({ reason: "resume" }, ctx);
    expect(handlers.setSessionName).not.toHaveBeenCalled();
    expect(ctx.sessionManager.getSessionName()).toBeUndefined();
    expect(ctx.ui.setTitle).toHaveBeenLastCalledWith(`leader-${name}`);
    expect(titles).toEqual([`leader-${name}`]);
    await handlers.get("turn_start")!({}, ctx);
    expect(ctx.ui.setTitle).toHaveBeenLastCalledWith(`leader-${name}`);
    ctx.sessionManager.getSessionName.mockReturnValue("Human label");
    ctx.ui.setTitle("native-default:Human label");
    await handlers.get("session_info_changed")!({ name: "Human label" }, ctx);
    expect(ctx.ui.setTitle).toHaveBeenLastCalledWith(`leader-${name}`);
    expect(handlers.setSessionName).not.toHaveBeenCalled();
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
    expect(handlers.setSessionName).toHaveBeenCalledExactlyOnceWith("Human label");
    expect(ctx.ui.setTitle).toHaveBeenLastCalledWith("native-default:Human label");
    const compactCount = titles.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(titles).toHaveLength(compactCount);
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
    const renameHooks: Promise<void>[] = [];
    handlers.setSessionName.mockImplementation((label: string) => {
      ctx.sessionManager.getSessionName.mockReturnValue(label);
      renameHooks.push(handlers.get("session_info_changed")!({ name: label }, ctx));
    });

    await handlers.get("session_start")!({ reason: "resume" }, ctx);
    expect(ctx.ui.setTitle).toHaveBeenCalledWith("worker");
    expect(titles).toEqual(["worker"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(titles).toEqual(["worker", "worker", "worker", "worker"]);

    await handlers.get("turn_start")!({}, ctx);
    expect(ctx.ui.setTitle).toHaveBeenCalledTimes(5);
    expect(titles).toHaveLength(5);
    expect(handlers.setSessionName).toHaveBeenCalledExactlyOnceWith(`${name}/worker`);
    expect(handlers.setSessionName.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(DirectMessageDelivery.prototype.start).mock.invocationCallOrder[0]);
    ctx.sessionManager.getSessionName.mockReturnValue("Foreign title");
    await handlers.get("session_info_changed")!({ name: "Foreign title" }, ctx);
    await Promise.all(renameHooks);
    expect(ctx.sessionManager.getSessionName()).toBe(`${name}/worker`);
    expect(handlers.setSessionName).toHaveBeenCalledTimes(2);
    expect(ctx.ui.setTitle).toHaveBeenLastCalledWith("worker");
  });
});
