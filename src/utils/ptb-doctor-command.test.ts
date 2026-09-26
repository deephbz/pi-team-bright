import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import * as paths from "./paths";
import * as teams from "./teams";
import type { TeamConfig } from "./models";
import * as doctor from "./ptb-doctor-command";

type Command = {
  description: string;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
  handler: (args: string, ctx: any) => Promise<void>;
};

function harness() {
  const commands = new Map<string, Command>();
  const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools: string[] = [];
  const sendMessage = vi.fn();
  const sendUserMessage = vi.fn();
  const appendEntry = vi.fn();
  piTeams({
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    on: (name: string, handler: (event: any, ctx: any) => unknown) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    sendMessage,
    sendUserMessage,
    appendEntry,
  } as never);
  return { command: commands.get("ptb"), commands, tools, hooks, sendMessage, sendUserMessage, appendEntry };
}

function session(sessionFile: string) {
  let id = "session-1";
  let file = sessionFile;
  let branch = [{ id: "root-1" }];
  let leaf = "root-1";
  let idle = true;
  const notify = vi.fn();
  return {
    ctx: {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => idle,
      ui: { notify, setStatus: vi.fn(), setTitle: vi.fn(), setFooter: vi.fn() },
      sessionManager: {
        getSessionId: () => id,
        getSessionFile: () => file,
        getBranch: () => branch,
        getLeafId: () => leaf,
      },
    },
    notify,
    setId(value: string) { id = value; },
    setFile(value: string) { file = value; },
    setBranch(value: string) { branch = [{ id: value }]; leaf = value; },
    setIdle(value: boolean) { idle = value; },
  };
}

function team(name: string, sessionFile: string, backend: "graph" | "beads" = "graph") {
  const config: TeamConfig = {
    name,
    description: "doctor fixture with PRIVATE_DESCRIPTION_TOKEN",
    createdAt: Date.now(),
    epochId: `epoch-${name}`,
    leadAgentId: `lead@${name}`,
    leadSessionId: sessionFile,
    members: [{
      membershipId: `membership-${name}`,
      agentId: `lead@${name}`,
      name: "team-lead",
      agentType: "lead",
      joinedAt: Date.now(),
      cwd: process.cwd(),
      subscriptions: [],
      sessionFile,
      prompt: "PRIVATE_MEMBER_PROMPT_TOKEN",
    }],
    ...(backend === "beads" ? {
      taskBackend: "beads" as const,
      taskWorkspace: path.join(paths.teamDir(name), "PRIVATE_WORKSPACE_TOKEN"),
      taskAuthorityId: "PRIVATE_AUTHORITY_ID_TOKEN",
      taskAuthorityFingerprint: {
        schema: "pi-teams-beads-authority/1" as const,
        backend: "dolt" as const,
        database: "dolt" as const,
        doltDatabase: "PRIVATE_DATABASE_TOKEN",
        projectId: "PRIVATE_PROJECT_TOKEN",
      },
    } : {}),
  };
  fs.mkdirSync(paths.teamDir(name), { recursive: true });
  teams.writeConfigAtomic(paths.configPath(name), config);
  return config;
}

function treeBytes(root: string): Record<string, string> {
  if (!fs.existsSync(root)) return {};
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(root, full)] = fs.readFileSync(full).toString("base64");
    }
  };
  walk(root);
  return files;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("registered /ptb doctor", () => {
  it("registers a small operator command with bounded completions and no new model tools", async () => {
    const before = harness();
    expect(before.command).toBeDefined();
    expect(before.commands.has("pi-team-bright")).toBe(true);
    const completions = before.command!.getArgumentCompletions;
    expect(completions?.("")?.map((item) => item.value)).toContain("doctor");
    expect(completions?.("do")?.map((item) => item.value)).toEqual(["doctor"]);
    expect(completions?.("doctor private-team") ?? []).toEqual([]);
    expect(before.tools).toHaveLength(9);
    expect(before.tools).not.toContain("ptb_doctor");
  });

  it("keeps bare, help, and malformed input side-effect-free", async () => {
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const run = harness();
    const state = session(path.join(process.env.PI_TEAMS_VITEST_HOME!, "help.jsonl"));
    const before = treeBytes(paths.TEAMS_DIR);
    for (const args of ["", "help", "doctor extra unexpected", "unknown", "doctor ../escape"]) {
      await run.command!.handler(args, state.ctx);
    }
    expect(state.notify).toHaveBeenCalled();
    expect(run.sendMessage).not.toHaveBeenCalled();
    expect(run.sendUserMessage).not.toHaveBeenCalled();
    expect(run.appendEntry).not.toHaveBeenCalled();
    expect(treeBytes(paths.TEAMS_DIR)).toEqual(before);
  });

  it("delivers a visible bounded guide and fresh graph metadata through followUp", async () => {
    const name = `doctor-graph-${process.pid}`;
    const file = path.join(process.env.PI_TEAMS_VITEST_HOME!, `${name}.jsonl`);
    team(name, file);
    vi.stubEnv("PI_TEAM_NAME", name);
    vi.stubEnv("PI_AGENT_NAME", "team-lead");
    const run = harness();
    const state = session(file);
    const before = treeBytes(paths.teamDir(name));
    await run.command!.handler("doctor", state.ctx);
    expect(run.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = run.sendMessage.mock.calls[0];
    expect(message).toMatchObject({ customType: "pi-team-bright.doctor", display: true });
    expect(options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(message.content).toContain(name);
    expect(message.content).toMatch(/guide|diagnos/i);
    for (const secret of ["PRIVATE_DESCRIPTION_TOKEN", "PRIVATE_MEMBER_PROMPT_TOKEN", "PRIVATE_WORKSPACE_TOKEN", "PRIVATE_AUTHORITY_ID_TOKEN", "PRIVATE_DATABASE_TOKEN", "PRIVATE_PROJECT_TOKEN"]) {
      expect(message.content).not.toContain(secret);
    }
    expect(run.sendUserMessage).not.toHaveBeenCalled();
    expect(run.appendEntry).not.toHaveBeenCalled();
    expect(treeBytes(paths.teamDir(name))).toEqual(before);
  });
});

function metadata(run: ReturnType<typeof harness>) {
  const content = run.sendMessage.mock.calls[0][0].content as string;
  return JSON.parse(content.split("Invocation metadata (observations, not authority):\n")[1]);
}

describe("doctor failure and ownership boundaries", () => {
  it("injects guidance without a Team and defers a busy turn", async () => {
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const run = harness();
    const state = session("/tmp/doctor-unbound.jsonl");
    state.setIdle(false);
    await run.command!.handler("doctor", state.ctx);
    expect(metadata(run).selection.team).toBe("none");
    expect(run.sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(state.notify).toHaveBeenCalledWith("Doctor queued after current turn.", "info");
  });

  it("diagnoses a named Team without binding, leaking prose, or taking its held lock", async () => {
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const name = `doctor-held-${process.pid}`;
    team(name, "/tmp/other-session.jsonl", "beads");
    fs.mkdirSync(`${paths.configPath(name)}.lock`, { recursive: true });
    fs.writeFileSync(path.join(`${paths.configPath(name)}.lock`, "owner.json"), JSON.stringify({ pid: process.pid }));
    const before = treeBytes(paths.teamDir(name));
    const run = harness();
    const state = session("/tmp/doctor-inspector.jsonl");
    await run.command!.handler(`doctor ${name}`, state.ctx);
    const report = metadata(run);
    expect(report.selection.runtime_bound_team).toBe("none");
    expect(report.team.session_binding).toBe("not_bound_to_selected_team");
    expect(report.team.effective_authority).toBe("beads_configured");
    expect(report.team.task_workspace).toContain("PRIVATE_WORKSPACE_TOKEN");
    expect(run.sendMessage.mock.calls[0][0].content).not.toContain("PRIVATE_MEMBER_PROMPT_TOKEN");
    expect(run.sendMessage.mock.calls[0][0].content).not.toContain("PRIVATE_DATABASE_TOKEN");
    expect(treeBytes(paths.teamDir(name))).toEqual(before);
  }, 1000);

  it.each(["missing", "corrupt", "oversized"])("keeps %s config evidence available", async (kind) => {
    const name = `doctor-${kind}-${process.pid}`;
    fs.mkdirSync(paths.teamDir(name), { recursive: true });
    if (kind !== "missing") fs.writeFileSync(paths.configPath(name), kind === "corrupt" ? "SECRET_INVALID_JSON" : "x".repeat(300000));
    const run = harness();
    await run.command!.handler(`doctor ${name}`, session("/tmp/doctor-partial.jsonl").ctx);
    expect(metadata(run).team.config_state).toBe({ missing: "missing", corrupt: "invalid_json", oversized: "too_large" }[kind]);
    expect(run.sendMessage.mock.calls[0][0].content).not.toContain("SECRET_INVALID_JSON");
  });

  it("does not fall back to Beads when graph JSON is damaged", async () => {
    const name = `doctor-graph-damaged-${process.pid}`;
    team(name, "/tmp/doctor-graph.jsonl", "beads");
    fs.mkdirSync(path.dirname(paths.graphTaskAuthorityPath(name)), { recursive: true });
    fs.writeFileSync(paths.graphTaskAuthorityPath(name), "SECRET_GRAPH_DAMAGE");
    const run = harness();
    await run.command!.handler(`doctor ${name}`, session("/tmp/doctor-graph.jsonl").ctx);
    expect(metadata(run).team).toMatchObject({ graph_state: "invalid_json", effective_authority: "graph_snapshot_present" });
    expect(run.sendMessage.mock.calls[0][0].content).not.toContain("SECRET_GRAPH_DAMAGE");
  });

  it.each(["session", "branch", "reload"])("cancels a late diagnostic after %s changes", async (kind) => {
    let release!: (content: string) => void;
    vi.spyOn(doctor, "collectPtbDoctorContext").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const run = harness();
    const state = session("/tmp/doctor-old.jsonl");
    const pending = run.command!.handler("doctor", state.ctx);
    if (kind === "session") { state.setId("new-session"); state.setFile("/tmp/doctor-new.jsonl"); }
    if (kind === "branch") state.setBranch("new-leaf");
    if (kind === "reload") for (const hook of run.hooks.get("session_shutdown") ?? []) await hook({ reason: "reload" }, state.ctx);
    release("late context");
    await pending;
    expect(run.sendMessage).not.toHaveBeenCalled();
    expect(state.notify.mock.calls.at(-1)?.[0]).toContain("cancelled");
  });

  it("reports unavailable guide and failed dispatch without claiming success", async () => {
    const state = session("/tmp/doctor-failure.jsonl");
    const run = harness();
    vi.spyOn(doctor, "collectPtbDoctorContext").mockRejectedValueOnce(new Error("SECRET_ERROR"));
    await run.command!.handler("doctor", state.ctx);
    expect(run.sendMessage).not.toHaveBeenCalled();
    expect(state.notify.mock.calls.at(-1)?.[1]).toBe("error");
    expect(JSON.stringify(state.notify.mock.calls)).not.toContain("SECRET_ERROR");
    vi.restoreAllMocks();
    run.sendMessage.mockImplementationOnce(() => { throw new Error("SECRET_SEND_FAILURE"); });
    await run.command!.handler("doctor", state.ctx);
    expect(state.notify.mock.calls.at(-1)?.[1]).toBe("error");
    expect(JSON.stringify(state.notify.mock.calls)).not.toContain("Doctor context submitted");
  });
});
