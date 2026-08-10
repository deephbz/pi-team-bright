import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { clearAdapterCache, setAdapter } from "../adapters/terminal-registry";
import { TeamSessionLifecycleService } from "../team-authority/team-session-lifecycle-service";
import { DirectMessageDelivery } from "./message-delivery";
import * as paths from "./paths";
import * as runtime from "./runtime";
import { SyncNudgeConductor } from "./sync-nudge-conductor";
import { TaskChangeDelivery } from "./task-delivery";
import * as teamEvents from "./team-events";
import * as teams from "./teams";

const createdTeams: string[] = [];

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
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: { isUsingOAuth: vi.fn(() => false), getProvider: vi.fn(() => undefined) },
    getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 10_000, percent: 1 })),
    ui: { notify: vi.fn(), setStatus: vi.fn(), setFooter: vi.fn(), setTitle: vi.fn() },
  } as any;
}

function extension() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  piTeams({
    on(event: string, handler: (event: any, ctx: any) => Promise<void>) { handlers.set(event, handler); },
    registerTool() {},
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
  } as never);
  return handlers;
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

    const ctx = context(sessionFile);
    await extension().get("session_start")!({ reason: "resume" }, ctx);

    expect(order).toEqual(["direct", "task"]);
    expect(claim).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
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

  it("refuses foreign resumed-lead placement without delivery or nudge and shuts down the candidate", async () => {
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
    expect(ctx.shutdown).toHaveBeenCalledOnce();
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
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);

    expect(directStop).toHaveBeenCalledOnce();
    expect(taskStop).toHaveBeenCalledOnce();
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
