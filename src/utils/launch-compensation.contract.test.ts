import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { clearAdapterCache, setAdapter } from "../adapters/terminal-registry";
import type { TerminalAdapter } from "./terminal-adapter";
import * as paths from "./paths";
import * as teams from "./teams";
import * as tasks from "./tasks";
import { formatPiTeamsToolResult } from "./tool-result-renderer";

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

function context(sessionFile: string) {
  return {
    cwd: process.cwd(),
    sessionManager: {
      getSessionFile: () => sessionFile,
      buildContextEntries: () => [],
    },
    ui: { setStatus() {}, notify() {} },
  };
}

function adapter(options: { alive?: boolean } = {}) {
  const spawn = vi.fn(() => "pane-worker");
  const kill = vi.fn();
  const terminal: TerminalAdapter = {
    name: "launch-contract-terminal",
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

async function team(suffix: string) {
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
  vi.spyOn(tasks, "listTasksWithVersions").mockResolvedValue([]);
  await teams.createTeam(
    name,
    leadSession,
    "lead",
    undefined,
    undefined,
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
  it("does not create a Worker carrier when Membership preparation persistence fails", async () => {
    const f = await team("preparation-failure");
    const a = adapter();
    const tools = register(a.terminal);
    vi.spyOn(teams, "addMember").mockRejectedValueOnce(new Error("membership write failed"));

    await expect(tools.get("worker_ensure")!.execute(
      "ensure",
      { team_name: f.name, name: "worker", profile: "Do focused work", cwd: process.cwd() },
      undefined,
      undefined,
      context(f.leadSession),
    )).rejects.toThrow(/membership write failed/i);

    expect(a.spawn).not.toHaveBeenCalled();
    const worker = (await teams.readConfig(f.name)).members.find((member) => member.name === "worker");
    expect(worker).toBeUndefined();
  });

  it("deactivates the exact prepared Membership when terminal launch fails before binding", async () => {
    const f = await team("terminal-launch-failure");
    const a = adapter();
    a.spawn.mockImplementationOnce(() => { throw new Error("terminal launch failed"); });
    const tools = register(a.terminal);

    await expect(tools.get("worker_ensure")!.execute(
      "ensure",
      { team_name: f.name, name: "worker", profile: "Do focused work", cwd: process.cwd() },
      undefined,
      undefined,
      context(f.leadSession),
    )).rejects.toThrow(/terminal launch failed.*deactivated/i);

    expect(a.kill).not.toHaveBeenCalled();
    const worker = (await teams.readConfig(f.name)).members.find((member) => member.name === "worker");
    expect(worker).toMatchObject({ isActive: false, deactivationReason: "replaced" });
  });

  it("kills and confirms the returned pane before deactivating after binding persistence fails", async () => {
    const f = await team("binding-failure");
    const a = adapter();
    const tools = register(a.terminal);
    vi.spyOn(teams, "updateMembership").mockRejectedValueOnce(new Error("config write failed"));

    await expect(tools.get("worker_ensure")!.execute(
      "ensure",
      { team_name: f.name, name: "worker", profile: "Do focused work", cwd: process.cwd() },
      undefined,
      undefined,
      context(f.leadSession),
    )).rejects.toThrow(/config write failed.*deactivated/i);

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

    await expect(tools.get("worker_ensure")!.execute(
      "ensure",
      { team_name: f.name, name: "worker", profile: "Do focused work", cwd: process.cwd() },
      undefined,
      undefined,
      context(f.leadSession),
    )).rejects.toThrow(/pane pane-worker.*remains current/i);

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
      { team_name: f.name },
      undefined,
      undefined,
      context(f.leadSession),
    );
    expect(result.content[0].text).toMatch(new RegExp(`Team ${f.name} shut down`));
    expect(() => JSON.parse(result.content[0].text)).toThrow();
    expect(result.details).toMatchObject({
      schema: "pi-teams-tool-result/1",
      operation: "team_shutdown",
      outcome: "accepted",
      postState: {
        lifecycle: "shut_down",
        stoppedWorkers: 0,
        deactivatedMembers: ["team-lead"],
        failures: [],
        unfinishedTasks: [],
        taskAuthorityRetained: true,
      },
      evidence: {
        stop: [],
      },
    });
    expect(result.details.diagnostics).toMatchObject({
      staleBindings: [],
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
    vi.mocked(tasks.listTasksWithVersions).mockResolvedValue([{
      id: "task-open",
      title: "Retained unfinished work",
      description: "Keep this Task across partial shutdown.",
      acceptanceCriteria: "The retry preserves the Task authority.",
      status: "open",
      relations: [],
      version: "task-version-1",
      provenance: { authority: "beads", teamName: f.name },
    }]);

    const result = await tools.get("team_shutdown")!.execute(
      "shutdown-partial",
      { team_name: f.name },
      undefined,
      undefined,
      context(f.leadSession),
    );
    const agentText = result.content[0].text as string;

    expect(agentText).toContain(`Team ${f.name} shutdown partially completed`);
    expect(agentText).toContain("Team remains active with team-lead, delivery-broken current");
    expect(agentText).toContain("stop wasn't confirmed for delivery-broken.");
    expect(agentText).toContain("Task authority and 1 unfinished Task retained; resolve the failure and retry.");
    expect(agentText).not.toContain("whose Membership remains current");
    expect(result.details).toMatchObject({
      schema: "pi-teams-tool-result/1",
      outcome: "partial",
      operation: "team_shutdown",
      postState: {
        lifecycle: "active",
        shutdownOutcome: "partial",
        currentMembers: ["team-lead", "delivery-broken"],
        failures: [{
          name: "delivery-broken",
          reason: "stop_not_confirmed",
          membershipRemainsCurrent: true,
        }],
        unfinishedTasks: [{ id: "task-open", status: "open", version: "task-version-1" }],
        taskAuthorityRetained: true,
      },
      nextActions: [{ tool: "team_shutdown", args: { team_name: f.name } }],
      evidence: { stopFailures: [{ name: "delivery-broken" }] },
    });

    const human = formatPiTeamsToolResult({
      tool: "team_shutdown",
      args: { team_name: f.name },
      details: result.details,
      content: result.content,
      expanded: false,
    }).map(line => line.text).join("\n");
    expect(human).toContain(`Shut Down Team · partial · Team ${f.name} · active`);
    expect(human).toContain("1 failed · 1 unfinished Tasks retained");
    expect(human).toContain("Current members: team-lead, delivery-broken");
    expect(human).toContain("delivery-broken: Worker stop couldn't be confirmed");
    expect(human).toContain("→ team_shutdown — Resolve the named Worker stop failures, then retry.");
  });
});
