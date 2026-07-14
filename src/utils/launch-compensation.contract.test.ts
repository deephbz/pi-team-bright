import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { clearAdapterCache, setAdapter } from "../adapters/terminal-registry";
import type { TerminalAdapter } from "./terminal-adapter";
import * as paths from "./paths";
import * as teams from "./teams";
import * as messaging from "./messaging";
import * as tasks from "./tasks";
import * as predefined from "./predefined-teams";
import { DirectMessageDelivery } from "./message-delivery";
import { TaskChangeDelivery } from "./task-delivery";

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
  await teams.createTeam(name, leadSession, "lead");
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

describe("compensated teammate launch", () => {
  it("deactivates the exact prepared Membership when the initial Message fails before spawn", async () => {
    const f = await team("message-failure");
    const a = adapter();
    const tools = register(a.terminal);
    vi.spyOn(messaging, "sendPlainMessage").mockRejectedValueOnce(new Error("inbox unavailable"));

    await expect(tools.get("spawn_teammate")!.execute(
      "spawn",
      { team_name: f.name, name: "worker", prompt: "do work", cwd: process.cwd() },
      undefined,
      undefined,
      context(f.leadSession),
    )).rejects.toThrow(/inbox unavailable.*deactivated/i);

    expect(a.spawn).not.toHaveBeenCalled();
    const worker = (await teams.readConfig(f.name)).members.find((member) => member.name === "worker");
    expect(worker).toMatchObject({ isActive: false, deactivationReason: "replaced" });
  });

  it("kills and confirms the returned pane before deactivating after binding persistence fails", async () => {
    const f = await team("binding-failure");
    const a = adapter();
    const tools = register(a.terminal);
    vi.spyOn(teams, "updateMembership").mockRejectedValueOnce(new Error("config write failed"));

    await expect(tools.get("spawn_teammate")!.execute(
      "spawn",
      { team_name: f.name, name: "worker", prompt: "do work", cwd: process.cwd() },
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

    await expect(tools.get("spawn_teammate")!.execute(
      "spawn",
      { team_name: f.name, name: "worker", prompt: "do work", cwd: process.cwd() },
      undefined,
      undefined,
      context(f.leadSession),
    )).rejects.toThrow(/pane pane-worker.*remains current/i);

    expect(a.kill).toHaveBeenCalledWith("pane-worker");
    const worker = (await teams.readConfig(f.name)).members.find((member) => member.name === "worker");
    expect(worker?.isActive).not.toBe(false);
  });

  it("applies the same compensation to predefined members and rejects partial launch as an error", async () => {
    const name = unique("predefined-message-failure");
    const leadSession = `/tmp/${name}-lead.jsonl`;
    const a = adapter();
    vi.spyOn(tasks, "resolveTeamTaskAuthority").mockResolvedValue({
      workspace: `/tmp/${name}-beads`,
      authorityId: `authority-${name}`,
      fingerprint: {
        schema: "pi-teams-beads-authority/1",
        backend: "dolt",
        database: "dolt",
        doltDatabase: `launch_${name}`,
        projectId: `launch-${name}`,
      },
    });
    vi.spyOn(predefined, "getPredefinedTeam").mockReturnValue({ name: "reviewers", agents: ["worker"] });
    vi.spyOn(predefined, "getAllAgentDefinitions").mockReturnValue([{
      name: "worker",
      description: "worker",
      prompt: "review",
      filePath: "/tmp/worker.md",
    }]);
    vi.spyOn(messaging, "sendPlainMessage").mockRejectedValueOnce(new Error("inbox unavailable"));
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockResolvedValue();
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockResolvedValue();
    const tools = register(a.terminal);

    await expect(tools.get("create_predefined_team")!.execute(
      "predefined",
      { team_name: name, predefined_team: "reviewers", cwd: process.cwd() },
      undefined,
      undefined,
      context(leadSession),
    )).rejects.toThrow(/only partially launched[\s\S]*inbox unavailable/i);

    expect(a.spawn).not.toHaveBeenCalled();
    const worker = (await teams.readConfig(name)).members.find((member) => member.name === "worker");
    expect(worker).toMatchObject({ isActive: false, deactivationReason: "replaced" });
  });

  it("puts the structured shutdown receipt in model-visible content", async () => {
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
    const visible = JSON.parse(result.content[0].text);

    expect(visible).toMatchObject({
      status: "shut_down",
      teamName: f.name,
      deactivatedMembers: ["team-lead"],
      failures: [],
      staleBindings: [],
      stopEvidence: [],
      taskAuthorityRetained: true,
    });
    expect(visible).toMatchObject(result.details);
  });
});
