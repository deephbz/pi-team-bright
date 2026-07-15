import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import piTeams from "../../extensions/index";
import * as paths from "./paths";
import * as teams from "./teams";
import * as messaging from "./messaging";
import * as runtime from "./runtime";
import { DIRECT_MESSAGE_CUSTOM_TYPE } from "./message-delivery";

type Handler = (event: unknown, ctx: SessionContext) => Promise<void>;

type SessionContext = {
  isIdle: ReturnType<typeof vi.fn>;
  ui: {
    setStatus: ReturnType<typeof vi.fn>;
    setFooter: ReturnType<typeof vi.fn>;
  };
};

const testTeams: string[] = [];

function testTeamName(suffix: string) {
  const name = `session-resume-${suffix}-${process.pid}-${Date.now()}`;
  testTeams.push(name);
  return name;
}

function lifecycleContext(sessionFile: string) {
  return {
    mode: "tui",
    isIdle: vi.fn(() => false),
    sessionManager: { getSessionFile: vi.fn(() => sessionFile) },
    ui: { setStatus: vi.fn(), setFooter: vi.fn(), notify: vi.fn() },
  };
}

function registeredHandlers() {
  const handlers = new Map<string, Handler>();
  piTeams({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerTool() {},
    sendUserMessage() {},
  } as never);
  return handlers;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const teamName of testTeams.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
});

describe("Pi session lifecycle", () => {
  it("never injects a synthetic inbox bootstrap on first binding or same-Session resume", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TMUX", "");
    const teamName = testTeamName("bootstrap-once");
    const sessionFile = "/tmp/pi-teams-bootstrap-once.jsonl";
    paths.ensureDirs();
    await teams.createTeam(teamName, "session", "lead-agent");
    const launchId = teams.newLaunchId();
    await teams.addMember(teamName, {
      membershipId: teams.newMembershipId(),
      pendingLaunchId: launchId,
      agentId: `worker@${teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: process.cwd(),
      subscriptions: [],
    });
    vi.stubEnv("PI_TEAM_NAME", teamName);
    vi.stubEnv("PI_AGENT_NAME", "worker");
    vi.stubEnv("PI_AGENT_LAUNCH_ID", launchId);

    const firstHandlers = new Map<string, Handler>();
    const firstWake = vi.fn();
    piTeams({
      on(event: string, handler: Handler) { firstHandlers.set(event, handler); },
      registerTool() {},
      sendUserMessage: firstWake,
    } as never);
    const firstContext = lifecycleContext(sessionFile);
    await firstHandlers.get("session_start")?.({ reason: "startup" }, firstContext);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(firstWake).not.toHaveBeenCalled();
    await firstHandlers.get("session_shutdown")?.({ reason: "quit" }, firstContext);
    vi.stubEnv("PI_AGENT_LAUNCH_ID", "");

    const resumedHandlers = new Map<string, Handler>();
    const resumedWake = vi.fn();
    piTeams({
      on(event: string, handler: Handler) { resumedHandlers.set(event, handler); },
      registerTool() {},
      sendUserMessage: resumedWake,
    } as never);
    const resumedContext = lifecycleContext(sessionFile);
    await resumedHandlers.get("session_start")?.({ reason: "resume" }, resumedContext);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resumedWake).not.toHaveBeenCalled();
    await resumedHandlers.get("session_shutdown")?.({ reason: "quit" }, resumedContext);
  });

  it("wires direct Message acknowledgement through the first successful turn", async () => {
    vi.stubEnv("TMUX", "");
    vi.stubEnv("PI_TEAMS_MESSAGE_POLL_MS", "50");
    const teamName = testTeamName("direct-message");
    const sessionFile = "/tmp/pi-teams-direct-message.jsonl";
    paths.ensureDirs();
    await teams.createTeam(teamName, "session", "lead-agent");
    await teams.addMember(teamName, {
      agentId: `worker@${teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile,
      cwd: process.cwd(),
      subscriptions: [],
    });
    vi.stubEnv("PI_TEAM_NAME", teamName);
    vi.stubEnv("PI_AGENT_NAME", "worker");
    const first = await messaging.sendPlainMessage(teamName, "team-lead", "worker", "first full body", "first");
    const second = await messaging.sendPlainMessage(teamName, "team-lead", "worker", "second full body", "second");

    const handlers = new Map<string, Handler>();
    const sendMessage = vi.fn();
    const appendEntry = vi.fn();
    const sendUserMessage = vi.fn();
    piTeams({
      on(event: string, handler: Handler) { handlers.set(event, handler); },
      registerTool() {},
      sendMessage,
      appendEntry,
      sendUserMessage,
    } as never);
    const ctx = {
      ...lifecycleContext(sessionFile),
      sessionManager: {
        getSessionFile: vi.fn(() => sessionFile),
        buildContextEntries: vi.fn(() => []),
      },
    };

    await handlers.get("session_start")?.({ reason: "resume" }, ctx);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [batch, options] = sendMessage.mock.calls[0];
    expect(batch).toMatchObject({
      customType: DIRECT_MESSAGE_CUSTOM_TYPE,
      details: { messageIds: [first.id, second.id] },
    });
    expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect((await messaging.readInbox(teamName, "worker", true, false))).toHaveLength(2);

    await handlers.get("context")?.({
      messages: [{ role: "custom", customType: batch.customType, details: batch.details }],
    }, ctx);
    expect((await messaging.readInbox(teamName, "worker", true, false))).toHaveLength(2);
    await handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "error" } }, ctx);
    expect((await runtime.readRuntimeStatus(teamName, "worker"))?.ready).toBe(false);
    expect((await messaging.readInbox(teamName, "worker", true, false))).toHaveLength(2);
    await handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
    expect((await runtime.readRuntimeStatus(teamName, "worker"))?.ready).toBe(true);
    expect(appendEntry).toHaveBeenCalledWith(
      "pi-teams.direct-message-successful-turn-ack",
      expect.objectContaining({ messageIds: [first.id, second.id] }),
    );
    expect((await messaging.readInbox(teamName, "worker", true, false))).toHaveLength(0);
    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  });

  it("records successful runtime readiness even when delivery acknowledgement persistence fails", async () => {
    vi.stubEnv("TMUX", "");
    const teamName = testTeamName("ready-before-ack");
    const sessionFile = `/tmp/${teamName}.jsonl`;
    paths.ensureDirs();
    await teams.createTeam(teamName, "session", "lead-agent");
    await teams.addMember(teamName, {
      agentId: `worker@${teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile,
      cwd: process.cwd(),
      subscriptions: [],
    });
    vi.stubEnv("PI_TEAM_NAME", teamName);
    vi.stubEnv("PI_AGENT_NAME", "worker");
    await messaging.sendPlainMessage(teamName, "team-lead", "worker", "must remain recoverable", "ack fault");

    const handlers = new Map<string, Handler>();
    const sendMessage = vi.fn();
    piTeams({
      on(event: string, handler: Handler) { handlers.set(event, handler); },
      registerTool() {},
      sendMessage,
      appendEntry: vi.fn(() => { throw new Error("ack persistence fault"); }),
    } as never);
    const ctx = {
      ...lifecycleContext(sessionFile),
      sessionManager: {
        getSessionFile: vi.fn(() => sessionFile),
        buildContextEntries: vi.fn(() => []),
      },
    };

    await handlers.get("session_start")?.({ reason: "resume" }, ctx);
    const batch = sendMessage.mock.calls[0][0];
    await handlers.get("context")?.({
      messages: [{ role: "custom", customType: batch.customType, details: batch.details }],
    }, ctx);
    await expect(handlers.get("turn_end")?.(
      { message: { role: "assistant", stopReason: "stop" } },
      ctx,
    )).rejects.toThrow("ack persistence fault");
    expect((await runtime.readRuntimeStatus(teamName, "worker"))?.ready).toBe(true);
    expect((await messaging.readInbox(teamName, "worker", true, false))).toHaveLength(1);
    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  });

  it("does not inherit direct inbox delivery into a fork", async () => {
    vi.stubEnv("TMUX", "");
    const teamName = testTeamName("fork-isolation");
    paths.ensureDirs();
    await teams.createTeam(teamName, "session", "lead-agent");
    await teams.addMember(teamName, {
      agentId: `worker@${teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile: "/tmp/source-session.jsonl",
      cwd: process.cwd(),
      subscriptions: [],
    });
    vi.stubEnv("PI_TEAM_NAME", teamName);
    vi.stubEnv("PI_AGENT_NAME", "worker");
    await messaging.sendPlainMessage(teamName, "team-lead", "worker", "source-only pending", "open");

    const handlers = new Map<string, Handler>();
    const sendMessage = vi.fn();
    piTeams({
      on(event: string, handler: Handler) { handlers.set(event, handler); },
      registerTool() {},
      sendMessage,
      appendEntry() {},
      sendUserMessage() {},
    } as never);
    const ctx = {
      ...lifecycleContext("/tmp/fork-session.jsonl"),
      sessionManager: {
        getSessionFile: vi.fn(() => "/tmp/fork-session.jsonl"),
        buildContextEntries: vi.fn(() => []),
      },
    };
    await handlers.get("session_start")?.({ reason: "fork" }, ctx);
    expect(sendMessage).not.toHaveBeenCalled();
    expect((await messaging.readInbox(teamName, "worker", true, false))).toHaveLength(1);
    expect((await teams.readConfig(teamName)).members.find(member => member.name === "worker")?.sessionFile)
      .toBe("/tmp/source-session.jsonl");
    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  });

  it("rebinds a resumed lead by Pi session file and refreshes its tmux pane", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TMUX", "");
    vi.stubEnv("TMUX_PANE", "%resumed-lead");
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const teamName = testTeamName("lead");
    const sessionFile = "/tmp/pi-teams-resumed-lead.jsonl";
    paths.ensureDirs();
    await teams.createTeam(teamName, sessionFile, "lead-agent");
    fs.writeFileSync(paths.leadSessionPath(teamName), JSON.stringify({
      pid: -1,
      sessionFile,
      startedAt: 1,
    }));

    const handlers = registeredHandlers();
    const ctx = lifecycleContext(sessionFile);
    await handlers.get("session_start")?.({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-teams", undefined);
    expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
    expect((await teams.readConfig(teamName)).members.find(member => member.name === "team-lead")?.tmuxPaneId).toBe("%resumed-lead");
    expect(JSON.parse(fs.readFileSync(paths.leadSessionPath(teamName), "utf8"))).toMatchObject({
      pid: process.pid,
      sessionFile,
    });

    await handlers.get("session_shutdown")?.({}, ctx);
  });

  it("refreshes a resumed teammate's tmux pane before health checks", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TMUX", "");
    vi.stubEnv("TMUX_PANE", "%resumed-teammate");
    const teamName = testTeamName("teammate");
    paths.ensureDirs();
    await teams.createTeam(teamName, "session", "lead-agent");
    const launchId = teams.newLaunchId();
    await teams.addMember(teamName, {
      membershipId: teams.newMembershipId(),
      pendingLaunchId: launchId,
      agentId: `reviewer@${teamName}`,
      name: "reviewer",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "%dead-pane",
      cwd: process.cwd(),
      subscriptions: [],
    });
    vi.stubEnv("PI_TEAM_NAME", teamName);
    vi.stubEnv("PI_AGENT_NAME", "reviewer");
    vi.stubEnv("PI_AGENT_LAUNCH_ID", launchId);

    const handlers = registeredHandlers();
    const ctx = lifecycleContext("/tmp/pi-teams-resumed-teammate.jsonl");
    await handlers.get("session_start")?.({}, ctx);

    const reviewer = (await teams.readConfig(teamName)).members.find(member => member.name === "reviewer");
    expect(reviewer?.tmuxPaneId).toBe("%resumed-teammate");
    expect(reviewer?.sessionFile).toBe("/tmp/pi-teams-resumed-teammate.jsonl");
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  it("rebinds a resumed teammate by Pi session file without environment variables", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TMUX", "");
    vi.stubEnv("TMUX_PANE", "%envless-resume");
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const teamName = testTeamName("envless-teammate");
    const sessionFile = "/tmp/pi-teams-envless-resume.jsonl";
    paths.ensureDirs();
    await teams.createTeam(teamName, "session", "lead-agent");
    await teams.addMember(teamName, {
      agentId: `reviewer@${teamName}`,
      name: "reviewer",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "%dead-pane",
      sessionFile,
      cwd: process.cwd(),
      subscriptions: [],
    });

    const handlers = registeredHandlers();
    const ctx = lifecycleContext(sessionFile);
    await handlers.get("session_start")?.({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("00-pi-teams", undefined);
    expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
    const reviewer = (await teams.readConfig(teamName)).members.find(member => member.name === "reviewer");
    expect(reviewer?.tmuxPaneId).toBe("%envless-resume");
    expect(reviewer?.sessionFile).toBe(sessionFile);
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  it("never polls a replaced or shut-down lead session context", async () => {
    vi.useFakeTimers();
    const teamName = testTeamName("polling-context");
    await teams.createTeam(teamName, "session", "lead-agent");
    vi.spyOn(paths, "ensureDirs").mockImplementation(() => undefined);
    vi.stubEnv("PI_TEAM_NAME", teamName);

    const handlers = new Map<string, Handler>();
    piTeams({
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool() {},
      sendUserMessage() {},
    } as never);

    const first = lifecycleContext("session");
    const replacement = lifecycleContext("session");

    await handlers.get("session_start")?.({}, first);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await handlers.get("session_start")?.({}, replacement);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(first.isIdle).not.toHaveBeenCalled();
    expect(replacement.isIdle).not.toHaveBeenCalled();

    await handlers.get("session_shutdown")?.({}, replacement);
    // An in-flight filesystem-lock heartbeat may remain briefly after the
    // delivery intervals are stopped; it is not a context poll.
    await vi.advanceTimersByTimeAsync(30_000);

    expect(replacement.isIdle).not.toHaveBeenCalled();
  });
});
