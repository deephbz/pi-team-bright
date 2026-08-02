import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import * as messaging from "./messaging";
import * as paths from "./paths";
import * as tasks from "./tasks";
import * as teams from "./teams";
import * as runtime from "./runtime";

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

function registerExtension(legacyLeader = false) {
  if (legacyLeader) {
    vi.stubEnv("PI_TEAM_NAME", "legacy-test");
    vi.stubEnv("PI_AGENT_NAME", "team-lead");
  }
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
  it("alert_send rejects a nonexistent team without creating any state", async () => {
    const missingTeam = testTeamName("alert-missing-team");
    const sendAlert = registerExtension(true).toolsByName.get("alert_send")!;

    await expect(sendAlert.execute("rejected", {
      team_name: missingTeam,
      to: "worker",
      kind: "attention",
      text: "must not be written",
    }, undefined, undefined, context("/tmp/missing-session.jsonl"))).rejects.toThrow(/not found|does not exist/);

    expect(fs.existsSync(paths.teamDir(missingTeam))).toBe(false);
    expect(fs.existsSync(paths.inboxPath(missingTeam, "worker"))).toBe(false);
  });

  it("alert_send binds native delivery to the exact current recipient generation", async () => {
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
    const sendAlert = registerExtension(true).toolsByName.get("alert_send")!;

    const accepted: any = await sendAlert.execute("accepted", {
      team_name: teamName,
      to: "worker",
      kind: "attention",
      text: "before removal",
    }, undefined, undefined, context("session"));
    expect(accepted).toMatchObject({
      content: [{ type: "text", text: expect.stringMatching(/attention Alert accepted by worker.*No Task state changed/i) }],
      details: {
        schema: "pi-teams-tool-result/1",
        outcome: "accepted",
        operation: "alert_send",
        resource: { kind: "alert", id: expect.stringMatching(/^alert_/), teamName },
        postState: { to: "worker", recipients: ["worker"], taskStateChanged: false },
        evidence: { alertText: "before removal" },
      },
    });
    await teams.deactivateMember(teamName, "worker", "replaced");

    const refused: any = await sendAlert.execute("rejected", {
      team_name: teamName,
      to: "worker",
      kind: "attention",
      text: "after removal",
    }, undefined, undefined, context("session"));
    expect(refused).toMatchObject({
      content: [{ type: "text", text: expect.stringMatching(/not sent.*isn't a current Team member/i) }],
      details: {
        schema: "pi-teams-tool-result/1",
        outcome: "refused",
        operation: "alert_send",
        warnings: [{
          code: "alert_recipient_not_current",
          message: `Recipient 'worker' is not a current member of team '${teamName}'.`,
          resourceId: "worker",
        }],
      },
    });
    expect(await messaging.readInbox(teamName, "worker", false, false)).toHaveLength(1);
  });

  it("internal historical inspection never consumes the recipient's unread delivery record", async () => {
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
    const inspected = await messaging.readInbox(teamName, "worker", true, false);

    expect(inspected[0].id).toBe(accepted.id);
    const stillUnread = await messaging.readInbox(teamName, "worker", true, false);
    expect(stillUnread.map((message) => message.id)).toEqual([accepted.id]);
  });

  it("the internal broadcast backend preserves accepted IDs and recipient-specific partial failures", async () => {
    const teamName = testTeamName("partial-broadcast");
    await teams.createTeam(teamName, "receipt-session", "lead-agent");
    for (const name of ["worker-a", "worker-b"]) {
      await teams.addMember(teamName, {
        agentId: `${name}@${teamName}`,
        name,
        agentType: "teammate",
        joinedAt: Date.now(),
        tmuxPaneId: "",
        sessionFile: `/tmp/${teamName}-${name}.jsonl`,
        cwd: process.cwd(),
        subscriptions: [],
      });
    }
    fs.mkdirSync(paths.inboxPath(teamName, "worker-b"), { recursive: true });

    const result = await messaging.broadcastMessage(teamName, "team-lead", "body", "summary");

    expect(result.accepted).toEqual([
      { recipient: "worker-a", messageId: expect.stringMatching(/^message_/) },
    ]);
    expect(result.failures).toEqual([{
      recipient: "worker-b",
      error: expect.stringMatching(/EISDIR|directory/i),
    }]);
    expect(await messaging.readInbox(teamName, "worker-a", false, false)).toHaveLength(1);
    expect(result.accepted.map((receipt) => receipt.recipient)).not.toContain("worker-b");
  });

  it("alert_send exposes a partial announcement without claiming every native delivery succeeded", async () => {
    const teamName = testTeamName("partial-alert");
    await teams.createTeam(teamName, "receipt-session", "lead-agent");
    vi.spyOn(messaging, "broadcastMessage").mockResolvedValue({
      accepted: [{ recipient: "worker-a", messageId: "message_a" }],
      failures: [{ recipient: "worker-b", error: "disk full" }],
    });
    const sendAlert = registerExtension(true).toolsByName.get("alert_send")!;

    const result: any = await sendAlert.execute("partial", {
      team_name: teamName,
      to: "*",
      kind: "announcement",
      text: "body",
    }, undefined, undefined, context("receipt-session"));

    expect(result.details).toMatchObject({
      schema: "pi-teams-tool-result/1",
      outcome: "partial",
      operation: "alert_send",
      warnings: [{ code: "alert_delivery_failed", message: "Alert delivery wasn't accepted by this recipient.", resourceId: "worker-b" }],
      postState: { recipients: ["worker-a"], taskStateChanged: false },
      evidence: { failures: [{ recipient: "worker-b", error: "disk full" }] },
    });
    expect(result.content[0].text).toMatch(/partially accepted by worker-a/i);
    expect(result.content[0].text).toMatch(/wasn't accepted for worker-b/i);
    expect(result.content[0].text).not.toMatch(/accepted by all|broadcasted to all/i);
  });

  it("distinguishes an announcement with no eligible recipients from a bad recipient name", async () => {
    const teamName = testTeamName("zero-recipient-alert");
    await teams.createTeam(teamName, "lead-session", "lead-agent");
    const sendAlert = registerExtension(true).toolsByName.get("alert_send")!;

    const result: any = await sendAlert.execute("zero", {
      team_name: teamName,
      to: "*",
      kind: "announcement",
      text: "nobody else is here",
    }, undefined, undefined, context("lead-session"));

    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringMatching(/zero eligible Worker recipients.*nothing was delivered.*Reconcile the roster with team_sync.*whether to retry/is) }],
      details: {
        schema: "pi-teams-tool-result/1",
        outcome: "refused",
        operation: "alert_send",
        postState: {
          attemptedRecipient: "*",
          accepted: false,
          reason: "no_eligible_recipients",
          currentWorkers: [],
          taskStateChanged: false,
          teamStateChanged: false,
          team: { name: teamName },
        },
        warnings: [{
          code: "alert_no_eligible_recipients",
          message: "No other current Team member accepted the announcement.",
        }],
        nextActions: [
          { tool: "team_sync", args: { team_name: teamName } },
          { tool: "worker_ensure", args: { team_name: teamName } },
        ],
        evidence: {
          eligibleRecipients: 0,
          deliveryAttempts: 0,
          acceptedDeliveries: 0,
          eventAppended: false,
          alertEventCursor: null,
          taskStateChanged: false,
          teamStateChanged: false,
        },
      },
    });
    expect(result.content[0].text).not.toMatch(/no Alert event|no Team or Task state changed/i);
    expect(result.details.warnings[0]).not.toHaveProperty("resourceId");
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
    vi.spyOn(tasks, "listTasksWithVersions").mockResolvedValue([]);
    const shutdown = registerExtension().toolsByName.get("worker_stop")!;

    const result: any = await shutdown.execute("shutdown", {
      worker: "worker",
    }, undefined, undefined, context(leadSession));
    expect(result.details).toMatchObject({ kind: "unavailable", state_changed: false });
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
    const intendedLead = await teams.currentMembership(intendedTeam, "team-lead");
    await runtime.writeRuntimeStatus(intendedTeam, "team-lead", { pid: process.pid, startedAt: Date.now() }, intendedLead.membershipId);

    const { handlers } = registerExtension();
    const ctx = context(sessionFile);
    await handlers.get("session_start")?.({ reason: "resume" }, ctx);

    expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
    expect(JSON.parse(fs.readFileSync(paths.leadSessionPath(intendedTeam), "utf8"))).toMatchObject({
      pid: -1,
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
