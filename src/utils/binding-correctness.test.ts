import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import * as messaging from "./messaging";
import * as paths from "./paths";
import * as teams from "./teams";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: unknown, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
};

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

const testTeams: string[] = [];

function testTeamName(suffix: string): string {
  const name = `binding-${suffix}-${process.pid}-${Date.now()}-${testTeams.length}`;
  testTeams.push(name);
  return name;
}

function registerExtension() {
  const toolsByName = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler>();
  piTeams({
    registerTool(tool: RegisteredTool) { toolsByName.set(tool.name, tool); },
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    sendUserMessage() {},
  } as never);
  return { toolsByName, handlers };
}

function context(sessionFile: string) {
  return {
    mode: "tui",
    isIdle: vi.fn(() => false),
    sessionManager: { getSessionFile: vi.fn(() => sessionFile) },
    ui: { setStatus: vi.fn(), setFooter: vi.fn(), notify: vi.fn() },
  };
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

describe("current team binding correctness", () => {
  it("send_message rejects a nonexistent team without creating any state", async () => {
    const missingTeam = testTeamName("message-missing-team");
    const sendMessage = registerExtension().toolsByName.get("send_message")!;

    await expect(sendMessage.execute("rejected", {
      team_name: missingTeam,
      recipient: "worker",
      content: "must not be written",
      summary: "missing team",
    }, undefined, undefined, context("/tmp/missing-session.jsonl"))).rejects.toThrow(/not found|does not exist/);

    expect(fs.existsSync(paths.teamDir(missingTeam))).toBe(false);
    expect(fs.existsSync(paths.inboxPath(missingTeam, "worker"))).toBe(false);
  });

  it("send_message rejects a recipient removed from the current roster without appending another inbox record", async () => {
    const teamName = testTeamName("recipient");
    await teams.createTeam(teamName, "session", "lead-agent");
    await teams.addMember(teamName, {
      agentId: `worker@${teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile: `/tmp/${teamName}-worker.jsonl`,
      cwd: process.cwd(),
      subscriptions: [],
    });
    const sendMessage = registerExtension().toolsByName.get("send_message")!;

    const accepted = await sendMessage.execute("accepted", {
      team_name: teamName,
      recipient: "worker",
      content: "before removal",
      summary: "accepted",
    }, undefined, undefined, context("session"));
    expect(accepted).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining('"messageId":"message_') }],
      details: { messageId: expect.stringMatching(/^message_/) },
    });
    await teams.deactivateMember(teamName, "worker", "replaced");

    await expect(sendMessage.execute("rejected", {
      team_name: teamName,
      recipient: "worker",
      content: "after removal",
      summary: "must reject",
    }, undefined, undefined, context("session"))).rejects.toThrow(
      `recipient 'worker' is not a current member of team '${teamName}'. Contact or escalate to the team leader 'team-lead'`,
    );
    expect(await messaging.readInbox(teamName, "worker", false, false)).toHaveLength(1);
  });

  it("foreign read_inbox inspection never consumes the recipient's unread Message", async () => {
    const teamName = testTeamName("foreign-inbox");
    await teams.createTeam(teamName, "session", "lead-agent");
    await teams.addMember(teamName, {
      agentId: `worker@${teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile: `/tmp/${teamName}-worker.jsonl`,
      cwd: process.cwd(),
      subscriptions: [],
    });
    const accepted = await messaging.sendPlainMessage(teamName, "team-lead", "worker", "inspect only", "foreign inspection");
    const readInbox = registerExtension().toolsByName.get("read_inbox")!;

    const inspected: any = await readInbox.execute("inspect", {
      team_name: teamName,
      agent_name: "worker",
      unread_only: true,
    }, undefined, undefined, context("session"));

    expect(JSON.parse(inspected.content[0].text)[0].id).toBe(accepted.id);
    const stillUnread = await messaging.readInbox(teamName, "worker", true, false);
    expect(stillUnread.map((message) => message.id)).toEqual([accepted.id]);
  });

  it("broadcast_message exposes accepted IDs and partial failures without claiming all recipients", async () => {
    await teams.createTeam("receipt-only", "receipt-session", "lead-agent");
    testTeams.push("receipt-only");
    vi.spyOn(messaging, "broadcastMessage").mockResolvedValue({
      accepted: [{ recipient: "worker-a", messageId: "message_a" }],
      failures: [{ recipient: "worker-b", error: "disk full" }],
    });
    const broadcast = registerExtension().toolsByName.get("broadcast_message")!;

    const result: any = await broadcast.execute("partial", {
      team_name: "receipt-only",
      content: "body",
      summary: "summary",
    }, undefined, undefined, context("receipt-session"));

    expect(JSON.parse(result.content[0].text)).toEqual({
      accepted: [{ recipient: "worker-a", messageId: "message_a" }],
      failures: [{ recipient: "worker-b", error: "disk full" }],
    });
    expect(result.details.failures).toHaveLength(1);
    expect(result.content[0].text).not.toMatch(/broadcasted to all/i);
  });

  it("never signals a numeric PID from a stale per-name pid file", async () => {
    vi.stubEnv("TMUX", "");
    const teamName = testTeamName("stale-pid");
    const leadSession = `/tmp/${teamName}-lead.jsonl`;
    await teams.createTeam(teamName, leadSession, "lead-agent");
    await teams.updateMember(teamName, "team-lead", { sessionFile: leadSession });
    await teams.addMember(teamName, {
      agentId: `worker@${teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile: `/tmp/${teamName}-worker.jsonl`,
      cwd: process.cwd(),
      subscriptions: [],
    });
    fs.writeFileSync(path.join(paths.teamDir(teamName), "worker.pid"), "424242");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const shutdown = registerExtension().toolsByName.get("process_shutdown_approved")!;

    await expect(shutdown.execute("shutdown", {
      team_name: teamName,
      agent_name: "worker",
    }, undefined, undefined, context(leadSession))).rejects.toThrow(/no terminal adapter.*no exact Membership-bound runtime record/i);

    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(paths.teamDir(teamName), "worker.pid"))).toBe(true);
    expect((await teams.readConfig(teamName)).members.find((member) => member.name === "worker")?.isActive).not.toBe(false);
  });

  it("fails closed when one durable lead Session is registered to multiple teams", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TMUX", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const firstTeam = testTeamName("ambiguous-a");
    const secondTeam = testTeamName("ambiguous-b");
    const sessionFile = `/tmp/pi-teams-ambiguous-${process.pid}.jsonl`;
    for (const teamName of [firstTeam, secondTeam]) {
      await teams.createTeam(teamName, sessionFile, "lead-agent");
      fs.writeFileSync(paths.leadSessionPath(teamName), JSON.stringify({
        pid: -1,
        sessionFile,
        startedAt: 1,
      }));
    }

    const { handlers } = registerExtension();
    await expect(handlers.get("session_start")?.({ reason: "resume" }, context(sessionFile))).rejects.toThrow(
      new RegExp(`Ambiguous lead Session binding:.*${firstTeam}.*${secondTeam}.*Set PI_TEAM_NAME`),
    );
  });

  it("keeps explicit PI_TEAM_NAME authoritative when historical lead records are ambiguous", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TMUX", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const firstTeam = testTeamName("explicit-a");
    const intendedTeam = testTeamName("explicit-b");
    const sessionFile = `/tmp/pi-teams-explicit-${process.pid}.jsonl`;
    for (const teamName of [firstTeam, intendedTeam]) {
      await teams.createTeam(teamName, sessionFile, "lead-agent");
      fs.writeFileSync(paths.leadSessionPath(teamName), JSON.stringify({
        pid: -1,
        sessionFile,
        startedAt: 1,
      }));
    }
    vi.stubEnv("PI_TEAM_NAME", intendedTeam);

    const { handlers } = registerExtension();
    const ctx = context(sessionFile);
    await handlers.get("session_start")?.({ reason: "resume" }, ctx);

    expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
    expect(JSON.parse(fs.readFileSync(paths.leadSessionPath(intendedTeam), "utf8"))).toMatchObject({
      pid: process.pid,
      sessionFile,
    });
    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  });

  it("rejects an explicit PI_TEAM_NAME that does not exist without creating team state", async () => {
    vi.stubEnv("TMUX", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const missingTeam = testTeamName("missing-explicit");
    vi.stubEnv("PI_TEAM_NAME", missingTeam);

    const { handlers } = registerExtension();
    await expect(handlers.get("session_start")?.(
      { reason: "resume" },
      context(`/tmp/pi-teams-missing-explicit-${process.pid}.jsonl`),
    )).rejects.toThrow(
      `Explicit PI_TEAM_NAME '${missingTeam}' does not name a current team. Refusing implicit fallback or team-state creation`,
    );

    expect(fs.existsSync(paths.teamDir(missingTeam))).toBe(false);
    expect(fs.existsSync(paths.leadSessionPath(missingTeam))).toBe(false);
    expect(fs.existsSync(paths.inboxPath(missingTeam, "team-lead"))).toBe(false);
  });
});
