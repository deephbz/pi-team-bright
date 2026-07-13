import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import piTeams from "../../extensions/index";
import * as paths from "./paths";
import * as teams from "./teams";

type Handler = (event: unknown, ctx: SessionContext) => Promise<void>;

type SessionContext = {
  isIdle: ReturnType<typeof vi.fn>;
  ui: {
    setStatus: ReturnType<typeof vi.fn>;
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
    isIdle: vi.fn(() => false),
    sessionManager: { getSessionFile: vi.fn(() => sessionFile) },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
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
  it("rebinds a resumed lead by Pi session file and refreshes its tmux pane", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TMUX", "");
    vi.stubEnv("TMUX_PANE", "%resumed-lead");
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const teamName = testTeamName("lead");
    const sessionFile = "/tmp/pi-teams-resumed-lead.jsonl";
    paths.ensureDirs();
    teams.createTeam(teamName, "original-session", "lead-agent");
    fs.writeFileSync(paths.leadSessionPath(teamName), JSON.stringify({
      pid: -1,
      sessionFile,
      startedAt: 1,
    }));

    const handlers = registeredHandlers();
    const ctx = lifecycleContext(sessionFile);
    await handlers.get("session_start")?.({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-teams", `Lead @ ${teamName}`);
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
    teams.createTeam(teamName, "session", "lead-agent");
    await teams.addMember(teamName, {
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

    const handlers = registeredHandlers();
    const ctx = lifecycleContext("/tmp/pi-teams-resumed-teammate.jsonl");
    await handlers.get("session_start")?.({}, ctx);

    expect((await teams.readConfig(teamName)).members.find(member => member.name === "reviewer")?.tmuxPaneId).toBe("%resumed-teammate");
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  it("never polls a replaced or shut-down lead session context", async () => {
    vi.useFakeTimers();
    vi.spyOn(paths, "ensureDirs").mockImplementation(() => undefined);
    vi.stubEnv("PI_TEAM_NAME", "lifecycle-test");

    const handlers = new Map<string, Handler>();
    piTeams({
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool() {},
      sendUserMessage() {},
    } as never);

    const first = {
      isIdle: vi.fn(() => false),
      ui: { setStatus: vi.fn() },
    };
    const replacement = {
      isIdle: vi.fn(() => false),
      ui: { setStatus: vi.fn() },
    };

    await handlers.get("session_start")?.({}, first);
    expect(vi.getTimerCount()).toBe(1);
    await handlers.get("session_start")?.({}, replacement);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(first.isIdle).not.toHaveBeenCalled();
    expect(replacement.isIdle).toHaveBeenCalledTimes(1);

    await handlers.get("session_shutdown")?.({}, replacement);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(replacement.isIdle).toHaveBeenCalledTimes(1);
  });
});
