import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { clearAdapterCache, getTerminalAdapter, setAdapter } from "../adapters/terminal-registry";
import type { TerminalAdapter } from "./terminal-adapter";
import type { Member } from "./models";
import * as paths from "./paths";
import * as runtime from "./runtime";
import * as taskAuthority from "./tasks";
import * as teams from "./teams";
import { MODEL_TOOL_IMPLEMENTATION_VERSION } from "../../src/model-tool-contract/preview-constants";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: any, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<any>;
};

const createdTeams: string[] = [];

function uniqueTeam(suffix: string): string {
  const name = `topology-${suffix}-${process.pid}-${Date.now()}-${createdTeams.length}`;
  createdTeams.push(name);
  return name;
}

function context(sessionFile: string) {
  return {
    sessionManager: { getSessionFile: () => sessionFile },
    ui: { setStatus() {}, notify() {} },
  };
}

function member(name: string, sessionFile: string, tmuxPaneId: string): Member {
  return {
    membershipId: teams.newMembershipId(),
    agentId: `${name}@topology-contract`,
    name,
    agentType: "teammate",
    joinedAt: Date.now(),
    tmuxPaneId,
    sessionFile,
    cwd: process.cwd(),
    subscriptions: [],
    isActive: true,
  };
}

function registerExtension(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  piTeams({
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
    on() {},
    sendUserMessage() {},
  } as never);
  return tools;
}

async function createBeadsTeam(name: string, leadSession: string) {
  const taskWorkspace = paths.teamDir(name);
  fs.mkdirSync(`${taskWorkspace}/.beads`, { recursive: true });
  fs.writeFileSync(`${taskWorkspace}/.beads/metadata.json`, JSON.stringify({
    database: "dolt",
    backend: "dolt",
    dolt_database: "topology_contract",
    project_id: `topology-${name}`,
  }));
  vi.spyOn(taskAuthority, "listTasksWithVersions").mockResolvedValue([]);
  return teams.createTeam(
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
      doltDatabase: "topology_contract",
      projectId: `topology-${name}`,
    },
    undefined,
    terminalBinding(),
    MODEL_TOOL_IMPLEMENTATION_VERSION,
  );
}

/**
 * Mirror team_create: a Team binds the detected terminal backend at creation,
 * so lifecycle operations resolve it from durable authority instead of ambient
 * detection. Members keep legacy pane IDs to retain legacy-read coverage.
 */
function terminalBinding(): teams.TeamTerminalBinding | undefined {
  const detected = getTerminalAdapter();
  return detected ? { backend: detected.name } : undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearAdapterCache();
  for (const name of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
});

describe("Team topology/lifecycle lease", () => {
  it("prevents shutdown from reporting full closure while a concurrent ensure_worker remains current or live", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const spawned: string[] = [];
    const killed: string[] = [];
    const terminal: TerminalAdapter = {
      name: "topology-contract-terminal",
      isDirectCarrier: () => true,
      detect: () => true,
      spawn: (options) => {
        spawned.push(options.name);
        return `pane-${options.name}`;
      },
      kill: (paneId) => { killed.push(paneId); },
      isAlive: () => false,
      setTitle() {},
      supportsWindows: () => false,
      spawnWindow: () => "unused",
      setWindowTitle() {},
      killWindow() {},
      isWindowAlive: () => false,
    };
    setAdapter(terminal);

    const name = uniqueTeam("shutdown-spawn");
    const leadSession = `/tmp/${name}-lead.jsonl`;
    await createBeadsTeam(name, leadSession);
    const old = member("old", `/tmp/${name}-old.jsonl`, "pane-old");
    await teams.addMember(name, old);

    let releaseRuntimeRead!: () => void;
    const holdRuntimeRead = new Promise<void>((resolve) => { releaseRuntimeRead = resolve; });
    let runtimeReadEntered!: () => void;
    const didEnterRuntimeRead = new Promise<void>((resolve) => { runtimeReadEntered = resolve; });
    vi.spyOn(runtime, "readRuntimeStatus").mockImplementation(async (_teamName, agentName) => {
      if (agentName === "old") {
        runtimeReadEntered();
        await holdRuntimeRead;
      }
      return null;
    });

    const tools = registerExtension();
    const shutdown = tools.get("team_shutdown")!.execute(
      "shutdown",
      { team_name: name },
      undefined,
      undefined,
      context(leadSession),
    );
    await didEnterRuntimeRead;

    let ensureSettled = false;
    const ensured = tools.get("ensure_worker")!.execute(
      "ensure",
      {
        team_name: name,
        name: "new",
        scope: "Standing capability for new work",
        cwd: process.cwd(),
      },
      undefined,
      undefined,
      context(leadSession),
    ).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error) => ({ status: "rejected" as const, error }),
    ).finally(() => { ensureSettled = true; });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ensureSettled).toBe(true);
    expect(spawned).toEqual(["new"]);
    expect((await teams.readConfig(name)).members.some((candidate) => candidate.name === "new")).toBe(true);

    releaseRuntimeRead();
    const shutdownResult = await shutdown;
    const ensureResult = await ensured;

    expect(shutdownResult.details.kind).toMatch(/team_shutdown|partial/);
    expect(shutdownResult.details).toMatchObject({ lifecycle: expect.stringMatching(/stopped|active/) });
    expect(ensureResult.status).toBe("fulfilled");
    expect(killed).toEqual(["pane-old"]);
    expect(spawned).toEqual(["new"]);
    expect((await teams.readConfig(name)).members.filter((candidate) => candidate.isActive !== false).map((candidate) => candidate.name)).toContain("new");
  });

  it("serializes one Team while allowing another Team to progress without deadlock", async () => {
    const firstTeam = uniqueTeam("same-a");
    const secondTeam = uniqueTeam("other-b");
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const didEnterFirst = new Promise<void>((resolve) => { firstEntered = resolve; });
    let sameTeamEntered = false;
    let otherTeamEntered = false;

    const first = teams.withTeamTopologyLease(firstTeam, async () => {
      firstEntered();
      await holdFirst;
    });
    await didEnterFirst;
    const same = teams.withTeamTopologyLease(firstTeam, async () => { sameTeamEntered = true; });
    const other = teams.withTeamTopologyLease(secondTeam, async () => { otherTeamEntered = true; });

    await other;
    expect(otherTeamEntered).toBe(true);
    expect(sameTeamEntered).toBe(false);

    releaseFirst();
    await Promise.all([first, same]);
    expect(sameTeamEntered).toBe(true);
  });

  it("rejects empty Team and member identities before they can alias storage paths", async () => {
    expect(() => paths.sanitizeName("")).toThrow(/must not be empty/i);
    expect(() => paths.teamDir("")).toThrow(/must not be empty/i);
    expect(() => paths.inboxPath("valid-team", "")).toThrow(/must not be empty/i);

    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    setAdapter({
      name: "unused",
      isDirectCarrier: () => true,
      detect: () => true,
      spawn: () => "unused",
      kill() {},
      isAlive: () => false,
      setTitle() {},
      supportsWindows: () => false,
      spawnWindow: () => "unused",
      setWindowTitle() {},
      killWindow() {},
      isWindowAlive: () => false,
    });
    const tools = registerExtension();
    await expect(tools.get("team_create")!.execute(
      "create-empty",
      { name: "", purpose: "invalid" },
      undefined,
      undefined,
      context("/tmp/empty-team-lead.jsonl"),
    )).rejects.toThrow(/must not be empty/i);
    const unavailable = await tools.get("ensure_worker")!.execute(
      "ensure-empty",
      { name: "", scope: "x" },
      undefined,
      undefined,
      context("/tmp/empty-member-lead.jsonl"),
    );
    expect(unavailable.details).toMatchObject({ kind: "unavailable", reason: "no_active_team", state_changed: false });
  });
});
