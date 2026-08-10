import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { clearAdapterCache, setAdapter } from "../adapters/terminal-registry";
import type { TerminalAdapter } from "./terminal-adapter";
import { assertTargetSupportedByTerminal, currentTerminalForTeam, terminalForTeam } from "./team-terminal";
import { terminalTarget } from "./terminal-target";
import * as paths from "./paths";
import * as runtime from "./runtime";
import * as teams from "./teams";

const created: string[] = [];

function name(suffix: string): string {
  const value = `terminal-backend-${suffix}-${process.pid}-${Date.now()}-${created.length}`;
  created.push(value);
  return value;
}

function adapter(backend: string, currentTargetId = "surface-current", direct = true): TerminalAdapter {
  return {
    name: backend,
    detect: vi.fn(() => true),
    currentTargetId: () => currentTargetId,
    isDirectCarrier: () => direct,
    spawn: () => "surface-worker",
    kill() {},
    isAlive: () => true,
    setTitle() {},
    supportsWindows: () => false,
    spawnWindow: () => { throw new Error("unsupported"); },
    setWindowTitle() {},
    killWindow() {},
    isWindowAlive: () => false,
  };
}

async function createBoundTeam(teamName: string, backend: string, leadTargetId = "surface-lead") {
  return teams.createTeam(
    teamName,
    `/tmp/${teamName}-lead.jsonl`,
    "lead",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      backend,
      leadTarget: terminalTarget(backend, "pane", leadTargetId),
    },
  );
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearAdapterCache();
  for (const teamName of created.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
});

describe("Team terminal backend binding", () => {
  it("persists one backend and a backend-qualified lead target", async () => {
    const teamName = name("create");
    const config = await createBoundTeam(teamName, "herdr", "w4:p6");

    expect(config.terminalBackend).toBe("herdr");
    expect(config.members.find(member => member.name === "team-lead")?.terminalTarget).toEqual({
      backend: "herdr",
      kind: "pane",
      targetId: "w4:p6",
    });
  });

  it("rejects a current Member target owned by another backend", async () => {
    const teamName = name("mismatch");
    await createBoundTeam(teamName, "herdr");

    await expect(teams.addMember(teamName, {
      membershipId: teams.newMembershipId(),
      pendingLaunchId: teams.newLaunchId(),
      agentId: `worker@${teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      terminalTarget: terminalTarget("tmux", "pane", "%9"),
      cwd: process.cwd(),
      subscriptions: [],
    })).rejects.toThrow(/does not match.*herdr/i);
  });

  it("resolves persisted lifecycle operations by backend ID without redetection", () => {
    const persisted = adapter("herdr");
    setAdapter(persisted);
    const config = { name: "bound", terminalBackend: "herdr", members: [] } as any;

    expect(terminalForTeam(config)).toBe(persisted);
    expect(persisted.detect).not.toHaveBeenCalled();
  });

  it("refuses spawning or resume from a different current backend", () => {
    setAdapter(adapter("tmux"));
    const config = { name: "bound", terminalBackend: "herdr", members: [] } as any;

    expect(() => currentTerminalForTeam(config)).toThrow(/bound to herdr.*running in tmux/i);
  });

  it("refuses launch from a nested carrier even when its backend identity matches", () => {
    setAdapter(adapter("herdr", "w4:p9", false));
    const config = { name: "bound", terminalBackend: "herdr", members: [] } as any;

    expect(() => currentTerminalForTeam(config)).toThrow(/nested terminal carrier/i);
  });

  it("refuses ambient lifecycle dispatch for terminal-bound legacy Teams", () => {
    setAdapter(adapter("tmux"));
    const config = {
      name: "legacy",
      members: [{ name: "worker", tmuxPaneId: "%4" }],
    } as any;

    expect(() => terminalForTeam(config)).toThrow(/predates terminalBackend.*ambient backend dispatch/i);
  });

  it("refuses a window target on a pane-only backend", async () => {
    const teamName = name("window-on-herdr");
    await createBoundTeam(teamName, "herdr");
    await expect(teams.addMember(teamName, {
      membershipId: teams.newMembershipId(),
      pendingLaunchId: teams.newLaunchId(),
      agentId: `worker@${teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      terminalTarget: terminalTarget("herdr", "window", "w4:window"),
      cwd: process.cwd(),
      subscriptions: [],
    })).resolves.toBeUndefined();
    expect(() => assertTargetSupportedByTerminal(adapter("herdr"), terminalTarget("herdr", "window", "w4:window")))
      .toThrow(/doesn't support windows/i);
  });

  it("refuses a resumed Herdr Session running through a nested carrier without rebinding it", async () => {
    vi.useFakeTimers();
    const herdr = adapter("herdr", "w4:p9", false);
    setAdapter(herdr);
    vi.stubEnv("TMUX", "/tmp/tmux/default,1,0");
    vi.stubEnv("TMUX_PANE", "%nested");
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_LAUNCH_ID", "");

    const teamName = name("resume");
    await createBoundTeam(teamName, "herdr");
    const sessionFile = `/tmp/${teamName}-worker.jsonl`;
    await teams.addMember(teamName, {
      membershipId: teams.newMembershipId(),
      agentId: `worker@${teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      terminalTarget: terminalTarget("herdr", "pane", "w4:p-old"),
      sessionFile,
      cwd: process.cwd(),
      subscriptions: [],
    });

    const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
    piTeams({
      on(event: string, handler: (event: unknown, ctx: any) => Promise<void>) { handlers.set(event, handler); },
      registerTool() {},
      sendUserMessage() {},
    } as never);
    const shutdown = vi.fn();
    const notified: Array<[string, string | undefined]> = [];
    const ctx = {
      shutdown,
      sessionManager: { getSessionFile: () => sessionFile, buildContextEntries: () => [] },
      ui: {
        setStatus() {},
        setFooter() {},
        notify(message: string, level?: string) { notified.push([message, level]); },
      },
    };

    await handlers.get("session_start")?.({}, ctx);
    const worker = (await teams.readConfig(teamName)).members.find(member => member.name === "worker");
    expect(worker?.terminalTarget).toEqual({ backend: "herdr", kind: "pane", targetId: "w4:p-old" });
    expect(await runtime.readRuntimeStatus(teamName, "worker")).toBeNull();
    expect(notified).toContainEqual([
      `Team ${teamName} is bound to terminal backend herdr, but this Pi process is inside a nested terminal carrier. Refusing to bind worker: a Team worker must be directly carried by its bound backend. Relaunch it directly from herdr.`,
      "error",
    ]);
    expect(shutdown).not.toHaveBeenCalled();
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  it("closes a launcher-spawned teammate started in a foreign backend instead of leaving it bound or idle", async () => {
    vi.useFakeTimers();
    setAdapter(adapter("tmux", "%7"));
    vi.stubEnv("TMUX", "/tmp/tmux/default,1,0");
    vi.stubEnv("TMUX_PANE", "%7");

    const teamName = name("foreign-launch");
    await createBoundTeam(teamName, "herdr");
    // The Membership already belongs to a live worker in the Team's own Herdr
    // pane; the refused process is a second launch of the same name in tmux.
    const herdrSession = `/tmp/${teamName}-herdr-worker.jsonl`;
    const sessionFile = `/tmp/${teamName}-tmux-intruder.jsonl`;
    const membershipId = teams.newMembershipId();
    await teams.addMember(teamName, {
      membershipId,
      agentId: `visual-1@${teamName}`,
      name: "visual-1",
      agentType: "teammate",
      joinedAt: Date.now(),
      terminalTarget: terminalTarget("herdr", "pane", "w4:pQ"),
      sessionFile: herdrSession,
      cwd: process.cwd(),
      subscriptions: [],
    });
    vi.stubEnv("PI_TEAM_NAME", teamName);
    vi.stubEnv("PI_AGENT_NAME", "visual-1");

    const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
    piTeams({
      on(event: string, handler: (event: unknown, ctx: any) => Promise<void>) { handlers.set(event, handler); },
      registerTool() {},
      sendUserMessage() {},
    } as never);
    const notified: Array<[string, string | undefined]> = [];
    const shutdown = vi.fn();
    const ctx = {
      shutdown,
      sessionManager: { getSessionFile: () => sessionFile, buildContextEntries: () => [] },
      ui: {
        setStatus() {},
        setFooter() {},
        notify(message: string, level?: string) { notified.push([message, level]); },
      },
    };

    await expect(handlers.get("session_start")?.({}, ctx)).resolves.toBeUndefined();

    // The Membership keeps the Session and Herdr surface its real process owns,
    // so the intruder can neither hijack the binding nor aim a later
    // worker_stop at its own tmux pane.
    const refused = (await teams.readConfig(teamName)).members.find(member => member.membershipId === membershipId);
    expect(refused?.terminalTarget).toEqual({ backend: "herdr", kind: "pane", targetId: "w4:pQ" });
    expect(refused?.sessionFile).toBe(herdrSession);
    expect(await runtime.readRuntimeStatus(teamName, "visual-1")).toBeNull();

    // The refusal is loud and the process does not survive as an idle pane.
    expect(notified).toContainEqual([expect.stringMatching(/bound to terminal backend herdr.*running in tmux/is), "error"]);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("keeps a resumed lead process alive while refusing to bind it across backends", async () => {
    vi.useFakeTimers();
    setAdapter(adapter("tmux", "%7"));
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");

    const teamName = name("foreign-resume");
    const config = await createBoundTeam(teamName, "herdr", "w4:pN");
    const leadSession = config.leadSessionId;

    const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
    piTeams({
      on(event: string, handler: (event: unknown, ctx: any) => Promise<void>) { handlers.set(event, handler); },
      registerTool() {},
      sendUserMessage() {},
    } as never);
    const shutdown = vi.fn();
    const notified: Array<[string, string | undefined]> = [];
    const ctx = {
      shutdown,
      sessionManager: { getSessionFile: () => leadSession, buildContextEntries: () => [] },
      ui: {
        setStatus() {},
        setFooter() {},
        notify(message: string, level?: string) { notified.push([message, level]); },
      },
    };

    await handlers.get("session_start")?.({}, ctx);

    const lead = (await teams.readConfig(teamName)).members.find(member => member.name === "team-lead");
    expect(lead?.terminalTarget).toEqual({ backend: "herdr", kind: "pane", targetId: "w4:pN" });
    expect(await runtime.readRuntimeStatus(teamName, "team-lead")).toBeNull();
    expect(notified).toContainEqual([
      `Team ${teamName} is bound to terminal backend herdr, but this Pi process is running in tmux. Refusing to bind team-lead: one Team epoch owns terminal surfaces in exactly one backend. Relaunch this process from herdr, or create a separate Team from this terminal.`,
      "error",
    ]);
    expect(shutdown).not.toHaveBeenCalled();
  });
});
