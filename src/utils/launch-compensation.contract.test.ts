import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { clearAdapterCache, setAdapter } from "../adapters/terminal-registry";
import type { TerminalAdapter } from "./terminal-adapter";
import * as paths from "./paths";
import * as teams from "./teams";
import * as tasks from "./tasks";
import { formatPiTeamsToolResult } from "./tool-result-renderer";
import { createWorkerLaunchBridge } from "./worker-launch-bridge";
import { MODEL_TOOL_IMPLEMENTATION_VERSION } from "../../src/model-tool-contract/preview-constants";

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
    undefined,
    undefined,
    MODEL_TOOL_IMPLEMENTATION_VERSION,
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
      workerAggregate: () => ({ projectTrusted: false }),
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
      tmuxPaneId: "pane-worker",
      isActive: true,
    });
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

    expect(() => JSON.parse(agentText)).not.toThrow();
    expect(result.details).toMatchObject({
      kind: "partial",
      lifecycle: "active",
      stopped_workers: [],
      failed_workers: ["delivery-broken"],
      unfinished_task_ids: ["task-open"],
      state_changed: true,
    });

    const human = formatPiTeamsToolResult({
      tool: "team_shutdown",
      args: {},
      details: result.details,
      content: result.content,
      expanded: false,
    }).map(line => line.text).join("\n");
    expect(human.length).toBeGreaterThan(0);
  });
});
