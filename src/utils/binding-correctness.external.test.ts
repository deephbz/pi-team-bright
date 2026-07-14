import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import * as messaging from "./messaging";
import * as paths from "./paths";
import * as runtime from "./runtime";
import * as teams from "./teams";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<unknown>;
};

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

const createdTeams: string[] = [];

function teamName(suffix: string): string {
  const name = `binding-external-${suffix}-${process.pid}-${Date.now()}-${createdTeams.length}`;
  createdTeams.push(name);
  return name;
}

function extensionHarness() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler>();
  piTeams({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    sendUserMessage() {},
  } as never);
  return { tools, handlers };
}

function sessionContext(sessionFile: string) {
  return {
    isIdle: vi.fn(() => false),
    sessionManager: { getSessionFile: vi.fn(() => sessionFile) },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  };
}

async function configureLeadRecord(name: string, sessionFile: string): Promise<string> {
  await teams.createTeam(name, sessionFile, "lead-agent");
  const serialized = JSON.stringify({ pid: -1, sessionFile, startedAt: 1 });
  fs.writeFileSync(paths.leadSessionPath(name), serialized);
  return serialized;
}

function expectNoInboxOrRuntime(name: string, agent = "team-lead") {
  expect(fs.existsSync(paths.inboxPath(name, agent))).toBe(false);
  expect(fs.existsSync(paths.runtimeStatusPath(name, agent))).toBe(false);
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const name of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
});

describe("external current-binding contract", () => {
  it("accepts a current offline member but rejects removed and unknown recipients without side effects", async () => {
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const name = teamName("recipients");
    await teams.createTeam(name, "lead-session", "lead-agent");
    await teams.addMember(name, {
      agentId: `worker@${name}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile: `/tmp/${name}-worker.jsonl`,
      cwd: process.cwd(),
      subscriptions: [],
    });
    await runtime.writeRuntimeStatus(name, "worker", {
      pid: 123,
      startedAt: 10,
      lastHeartbeatAt: 20,
      ready: false,
    });
    const runtimeBefore = fs.readFileSync(paths.runtimeStatusPath(name, "worker"), "utf8");
    const send = extensionHarness().tools.get("send_message")!;
    const ctx = { sessionManager: { getSessionFile: () => "lead-session" } };

    await send.execute("current", {
      team_name: name,
      recipient: "worker",
      content: "accepted while offline",
      summary: "current member",
    }, undefined, undefined, ctx);
    expect(await messaging.readInbox(name, "worker", false, false)).toHaveLength(1);
    expect(fs.readFileSync(paths.runtimeStatusPath(name, "worker"), "utf8")).toBe(runtimeBefore);

    await teams.deactivateMember(name, "worker", "replaced");
    const inboxBefore = fs.readFileSync(paths.inboxPath(name, "worker"), "utf8");
    await expect(send.execute("removed", {
      team_name: name,
      recipient: "worker",
      content: "must not append",
      summary: "removed member",
    }, undefined, undefined, ctx)).rejects.toThrow(/not a current member.*Contact or escalate.*team-lead/s);
    expect(fs.readFileSync(paths.inboxPath(name, "worker"), "utf8")).toBe(inboxBefore);
    expect(fs.readFileSync(paths.runtimeStatusPath(name, "worker"), "utf8")).toBe(runtimeBefore);

    await expect(send.execute("unknown", {
      team_name: name,
      recipient: "ghost",
      content: "must not create",
      summary: "unknown member",
    }, undefined, undefined, ctx)).rejects.toThrow(/not a current member.*Contact or escalate.*team-lead/s);
    expectNoInboxOrRuntime(name, "ghost");
  });

  it("resumes the sole matching lead Session without creating inbox or runtime state", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TMUX", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const name = teamName("single-lead");
    const sessionFile = `/tmp/${name}.jsonl`;
    await configureLeadRecord(name, sessionFile);

    const { handlers } = extensionHarness();
    const ctx = sessionContext(sessionFile);
    await handlers.get("session_start")!({ reason: "resume" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-teams", `Lead @ ${name}`);
    expect(JSON.parse(fs.readFileSync(paths.leadSessionPath(name), "utf8"))).toMatchObject({
      pid: process.pid,
      sessionFile,
    });
    expectNoInboxOrRuntime(name);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
  });

  it("fails closed on ambiguous lead Session matches without mutating either team", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TMUX", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const first = teamName("ambiguous-a");
    const second = teamName("ambiguous-b");
    const sessionFile = `/tmp/binding-external-ambiguous-${process.pid}.jsonl`;
    const firstBefore = await configureLeadRecord(first, sessionFile);
    const secondBefore = await configureLeadRecord(second, sessionFile);

    const { handlers } = extensionHarness();
    await expect(handlers.get("session_start")!({ reason: "resume" }, sessionContext(sessionFile)))
      .rejects.toThrow(/Ambiguous lead Session binding:.*Set PI_TEAM_NAME/s);

    expect(fs.readFileSync(paths.leadSessionPath(first), "utf8")).toBe(firstBefore);
    expect(fs.readFileSync(paths.leadSessionPath(second), "utf8")).toBe(secondBefore);
    expectNoInboxOrRuntime(first);
    expectNoInboxOrRuntime(second);
  });

  it("uses explicit PI_TEAM_NAME and leaves the other matching lead record untouched", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TMUX", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const other = teamName("explicit-other");
    const intended = teamName("explicit-intended");
    const sessionFile = `/tmp/binding-external-explicit-${process.pid}.jsonl`;
    const otherBefore = await configureLeadRecord(other, sessionFile);
    await configureLeadRecord(intended, sessionFile);
    vi.stubEnv("PI_TEAM_NAME", intended);

    const { handlers } = extensionHarness();
    const ctx = sessionContext(sessionFile);
    await handlers.get("session_start")!({ reason: "resume" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-teams", `Lead @ ${intended}`);
    expect(JSON.parse(fs.readFileSync(paths.leadSessionPath(intended), "utf8"))).toMatchObject({
      pid: process.pid,
      sessionFile,
    });
    expect(fs.readFileSync(paths.leadSessionPath(other), "utf8")).toBe(otherBefore);
    expectNoInboxOrRuntime(other);
    expectNoInboxOrRuntime(intended);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
  });

  it("rejects an explicit nonexistent PI_TEAM_NAME without fallback or state creation", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TMUX", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const historical = teamName("nonexistent-historical");
    const selected = teamName("nonexistent-selected");
    const sessionFile = `/tmp/binding-external-nonexistent-${process.pid}.jsonl`;
    const historicalBefore = await configureLeadRecord(historical, sessionFile);
    vi.stubEnv("PI_TEAM_NAME", selected);

    expect(fs.existsSync(paths.teamDir(selected))).toBe(false);
    expect(fs.existsSync(paths.taskDir(selected))).toBe(false);
    const { handlers } = extensionHarness();
    const ctx = sessionContext(sessionFile);

    await expect(handlers.get("session_start")!({ reason: "resume" }, ctx))
      .rejects.toThrow(/does not name a current team.*Refusing implicit fallback or team-state creation/s);

    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.teamDir(selected))).toBe(false);
    expect(fs.existsSync(paths.taskDir(selected))).toBe(false);
    expect(fs.readFileSync(paths.leadSessionPath(historical), "utf8")).toBe(historicalBefore);
    expectNoInboxOrRuntime(historical);
  });
});
