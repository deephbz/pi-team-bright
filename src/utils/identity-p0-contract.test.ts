import crypto from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { DIRECT_MESSAGE_CUSTOM_TYPE, DirectMessageDelivery } from "./message-delivery";
import type { InboxMessage, Member } from "./models";
import * as messaging from "./messaging";
import * as paths from "./paths";
import * as teams from "./teams";

type IdentityMember = Member & {
  membershipId: string;
  pendingLaunchId?: string;
  launchConsumedAt?: string;
};

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: unknown, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<any>;
};

type Handler = (event: any, ctx: any) => Promise<void>;

const createdTeams: string[] = [];

function uniqueTeam(suffix: string): string {
  const name = `identity-p0-${suffix}-${process.pid}-${Date.now()}-${createdTeams.length}`;
  createdTeams.push(name);
  return name;
}

function preparedMember(teamName: string, roleName: string, overrides: Partial<IdentityMember> = {}): IdentityMember {
  return {
    agentId: `${roleName}@${teamName}`,
    membershipId: `membership_${crypto.randomUUID()}`,
    pendingLaunchId: `launch_${crypto.randomUUID()}`,
    name: roleName,
    agentType: "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    cwd: process.cwd(),
    subscriptions: [],
    isActive: true,
    ...overrides,
  };
}

async function addPrepared(teamName: string, roleName = "worker"): Promise<IdentityMember> {
  const member = preparedMember(teamName, roleName);
  await teams.addMember(teamName, member);
  return member;
}

function bindMemberSession(
  teamName: string,
  roleName: string,
  sessionFile: string,
  launchId: string | undefined,
  runtimeLocation: Record<string, unknown> = {},
): Promise<unknown> {
  const bind = (teams as typeof teams & {
    bindMemberSession?: (
      teamName: string,
      roleName: string,
      sessionFile: string,
      launchId?: string,
      runtimeLocation?: Record<string, unknown>,
    ) => Promise<unknown>;
  }).bindMemberSession;
  if (!bind) throw new Error("identity P0 requires teams.bindMemberSession");
  return bind(teamName, roleName, sessionFile, launchId, runtimeLocation);
}

function currentMember(config: Awaited<ReturnType<typeof teams.readConfig>>, roleName = "worker"): IdentityMember {
  const member = [...config.members].reverse().find(candidate => candidate.name === roleName && candidate.isActive !== false);
  if (!member) throw new Error(`missing current ${roleName} Membership`);
  return member as IdentityMember;
}

function rawInbox(teamName: string, roleName = "worker"): Array<InboxMessage & { recipientMembershipId?: string }> {
  return JSON.parse(fs.readFileSync(paths.inboxPath(teamName, roleName), "utf8"));
}

function registerExtension() {
  const toolsByName = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler>();
  piTeams({
    registerTool(tool: RegisteredTool) { toolsByName.set(tool.name, tool); },
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
  } as never);
  return { toolsByName, handlers };
}

function lifecycleContext(sessionFile: string) {
  return {
    isIdle: vi.fn(() => false),
    sessionManager: {
      getSessionFile: vi.fn(() => sessionFile),
      buildContextEntries: vi.fn(() => []),
    },
    ui: { setStatus: vi.fn(), notify: vi.fn(), setTitle: vi.fn() },
  };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const teamName of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
});

describe("identity P0: Membership generation and first Session binding", () => {
  it("allocates a distinct Membership identity for every lead generation", async () => {
    const teamName = uniqueTeam("lead-generation");
    const first = await teams.createTeam(teamName, "session-a", "lead-a");
    await teams.deactivateMembership(teamName, first.members[0].membershipId!, "team_shutdown");
    const second = await teams.createTeam(teamName, "session-b", "lead-b");
    const leadHistory = second.members.filter(member => member.name === "team-lead") as IdentityMember[];

    expect((first.members[0] as IdentityMember).membershipId).toMatch(/^membership_/);
    expect(leadHistory).toHaveLength(2);
    expect(new Set(leadHistory.map(member => member.membershipId)).size).toBe(2);
    expect(leadHistory[0].isActive).toBe(false);
    expect(leadHistory[1].isActive).toBe(true);
  });

  it("rejects duplicate Membership identities instead of trusting caller convention", async () => {
    const teamName = uniqueTeam("duplicate-generation");
    await teams.createTeam(teamName, "session", "lead");
    const first = await addPrepared(teamName);

    await expect(teams.addMember(teamName, preparedMember(teamName, "reviewer", {
      membershipId: first.membershipId,
    }))).rejects.toThrow();
  });

  it("rejects current teammate generations that are neither PREPARED nor bound", async () => {
    const teamName = uniqueTeam("invalid-membership-state");
    await teams.createTeam(teamName, "session", "lead");
    const unbindable = preparedMember(teamName, "worker", { pendingLaunchId: undefined });
    await expect(teams.addMember(teamName, unbindable)).rejects.toThrow();

    const contradictory = preparedMember(teamName, "reviewer", {
      sessionFile: `/tmp/${teamName}-reviewer.jsonl`,
    });
    await expect(teams.addMember(teamName, contradictory)).rejects.toThrow();
  });

  it("consumes launchId exactly once, resumes only the exact Session, and never reactivates an ended Membership", async () => {
    const teamName = uniqueTeam("binding-state-machine");
    await teams.createTeam(teamName, "lead-session", "lead");
    const first = await addPrepared(teamName);
    const sessionFile = `/tmp/${teamName}-worker.jsonl`;

    await bindMemberSession(teamName, "worker", sessionFile, first.pendingLaunchId, { tmuxPaneId: "%first" });
    let bound = currentMember(await teams.readConfig(teamName));
    expect(bound).toMatchObject({
      membershipId: first.membershipId,
      sessionFile,
      tmuxPaneId: "%first",
    });
    expect(bound.pendingLaunchId).toBeUndefined();
    expect(bound.launchConsumedAt).toEqual(expect.any(String));

    await expect(bindMemberSession(teamName, "worker", sessionFile, first.pendingLaunchId)).rejects.toThrow();
    await expect(bindMemberSession(teamName, "worker", `${sessionFile}.fork`, undefined)).rejects.toThrow();
    await bindMemberSession(teamName, "worker", sessionFile, undefined, { tmuxPaneId: "%resumed" });
    expect(currentMember(await teams.readConfig(teamName)).tmuxPaneId).toBe("%resumed");

    await teams.deactivateMember(teamName, "worker", "process_shutdown");
    await expect(bindMemberSession(teamName, "worker", sessionFile, undefined)).rejects.toThrow();

    const replacement = await addPrepared(teamName);
    await bindMemberSession(teamName, "worker", sessionFile, replacement.pendingLaunchId, { tmuxPaneId: "%replacement" });
    const history = (await teams.readConfig(teamName)).members.filter(member => member.name === "worker") as IdentityMember[];
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ membershipId: first.membershipId, isActive: false, sessionFile });
    expect(history[1]).toMatchObject({ membershipId: replacement.membershipId, isActive: true, sessionFile });
  });

  it("prevents a stale same-name process from overwriting the current generation", async () => {
    const teamName = uniqueTeam("stale-writer");
    await teams.createTeam(teamName, "lead-session", "lead");
    const first = await addPrepared(teamName);
    const oldSession = `/tmp/${teamName}-old.jsonl`;
    await bindMemberSession(teamName, "worker", oldSession, first.pendingLaunchId, { tmuxPaneId: "%old" });
    await teams.deactivateMember(teamName, "worker", "process_shutdown");

    const replacement = await addPrepared(teamName);
    const currentSession = `/tmp/${teamName}-current.jsonl`;
    await bindMemberSession(teamName, "worker", currentSession, replacement.pendingLaunchId, { tmuxPaneId: "%current" });

    await expect(bindMemberSession(teamName, "worker", oldSession, undefined, { tmuxPaneId: "%stale" })).rejects.toThrow();
    await expect(teams.assertCurrentSessionBinding(teamName, "worker", oldSession)).rejects.toThrow();
    await expect(teams.assertCurrentSessionBinding(teamName, "worker", currentSession)).resolves.toMatchObject({
      membershipId: replacement.membershipId,
    });
    expect(currentMember(await teams.readConfig(teamName))).toMatchObject({
      membershipId: replacement.membershipId,
      sessionFile: currentSession,
      tmuxPaneId: "%current",
    });
  });

  it("fails closed when implicit Session discovery has active matches in multiple Teams", async () => {
    const sharedSession = `/tmp/pi-teams-ambiguous-membership-${process.pid}.jsonl`;
    for (const suffix of ["a", "b"]) {
      const teamName = uniqueTeam(`ambiguous-${suffix}`);
      await teams.createTeam(teamName, `lead-${suffix}`, `lead-${suffix}`);
      const member = await addPrepared(teamName);
      await bindMemberSession(teamName, "worker", sharedSession, member.pendingLaunchId);
    }

    expect(() => teams.findTeammateBySessionFile(sharedSession)).toThrow(/ambig|multiple/i);
  });

  it("fails closed when one lead Session is current in multiple Teams", async () => {
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("TMUX", "");
    const sharedSession = `/tmp/pi-teams-ambiguous-lead-${process.pid}.jsonl`;
    for (const suffix of ["a", "b"]) {
      await teams.createTeam(uniqueTeam(`ambiguous-lead-${suffix}`), sharedSession, `lead-${suffix}`);
    }

    const { handlers } = registerExtension();
    await expect(handlers.get("session_start")?.(
      { reason: "resume" },
      lifecycleContext(sharedSession),
    )).rejects.toThrow(/ambig|multiple/i);
  });
});

describe("identity P0: generation-scoped Communication and runtime projections", () => {
  it("stamps accepted Messages to the current Membership and never delivers or acknowledges them across generations", async () => {
    const teamName = uniqueTeam("message-generation");
    await teams.createTeam(teamName, "lead-session", "lead");
    const oldMember = await addPrepared(teamName);
    const oldSession = `/tmp/${teamName}-old.jsonl`;
    await bindMemberSession(teamName, "worker", oldSession, oldMember.pendingLaunchId);
    const oldMessage = await messaging.sendPlainMessage(teamName, "team-lead", "worker", "old generation", "old");
    expect(oldMessage).toMatchObject({ recipientMembershipId: oldMember.membershipId });

    await teams.deactivateMember(teamName, "worker", "process_shutdown");
    const newMember = await addPrepared(teamName);
    const newSession = `/tmp/${teamName}-new.jsonl`;
    await bindMemberSession(teamName, "worker", newSession, newMember.pendingLaunchId);
    const newMessage = await messaging.sendPlainMessage(teamName, "team-lead", "worker", "new generation", "new");
    expect(newMessage).toMatchObject({ recipientMembershipId: newMember.membershipId });

    const sink = { sendMessage: vi.fn(), appendEntry: vi.fn() };
    const delivery = new DirectMessageDelivery(sink, {
      teamName,
      recipient: "worker",
      membershipId: newMember.membershipId,
      sessionFile: newSession,
      pollMs: 60_000,
    } as any);
    await delivery.start([]);
    expect(sink.sendMessage).toHaveBeenCalledTimes(1);
    const batch = sink.sendMessage.mock.calls[0][0];
    expect(batch).toMatchObject({
      customType: DIRECT_MESSAGE_CUSTOM_TYPE,
      details: {
        recipientMembershipId: newMember.membershipId,
        messageIds: [newMessage.id],
      },
    });
    expect(batch.details.messageIds).not.toContain(oldMessage.id);

    await delivery.observeContext([{ role: "custom", customType: batch.customType, details: batch.details }]);
    await delivery.commitPresentedAfterSuccessfulTurn("stop");
    delivery.stop();

    const stored = rawInbox(teamName);
    expect(stored.find(message => message.id === oldMessage.id)).toMatchObject({
      recipientMembershipId: oldMember.membershipId,
      read: false,
    });
    expect(stored.find(message => message.id === newMessage.id)).toMatchObject({
      recipientMembershipId: newMember.membershipId,
      read: true,
    });

    const staleSink = { sendMessage: vi.fn(), appendEntry: vi.fn() };
    const stale = new DirectMessageDelivery(staleSink, {
      teamName,
      recipient: "worker",
      membershipId: oldMember.membershipId,
      sessionFile: oldSession,
      pollMs: 60_000,
    } as any);
    await stale.start([]);
    expect(staleSink.sendMessage).not.toHaveBeenCalled();
    stale.stop();
  });

  it("preserves legacy unscoped inbox evidence but excludes it from live delivery", async () => {
    const teamName = uniqueTeam("legacy-inbox");
    await teams.createTeam(teamName, "lead-session", "lead");
    const member = await addPrepared(teamName);
    const sessionFile = `/tmp/${teamName}.jsonl`;
    await bindMemberSession(teamName, "worker", sessionFile, member.pendingLaunchId);
    const inboxFile = paths.inboxPath(teamName, "worker");
    fs.mkdirSync(paths.teamDir(teamName) + "/inboxes", { recursive: true });
    fs.writeFileSync(inboxFile, JSON.stringify([{
      id: "legacy-unscoped",
      from: "team-lead",
      text: "historical unresolved evidence",
      summary: "legacy",
      timestamp: "2026-07-15T00:00:00.000Z",
      read: false,
    }], null, 2));

    const sink = { sendMessage: vi.fn(), appendEntry: vi.fn() };
    const delivery = new DirectMessageDelivery(sink, {
      teamName,
      recipient: "worker",
      membershipId: member.membershipId,
      sessionFile,
      pollMs: 60_000,
    } as any);
    await delivery.start([]);
    expect(sink.sendMessage).not.toHaveBeenCalled();
    delivery.stop();

    expect(rawInbox(teamName)).toEqual([
      expect.objectContaining({ id: "legacy-unscoped", read: false }),
    ]);
  });

  it("ignores stale-generation runtime readiness in the current teammate projection", async () => {
    const teamName = uniqueTeam("runtime-projection");
    await teams.createTeam(teamName, "lead-session", "lead");
    const oldMember = await addPrepared(teamName);
    const oldSession = `/tmp/${teamName}-old.jsonl`;
    await bindMemberSession(teamName, "worker", oldSession, oldMember.pendingLaunchId);
    await teams.deactivateMember(teamName, "worker", "process_shutdown");
    const newMember = await addPrepared(teamName);
    const newSession = `/tmp/${teamName}-new.jsonl`;
    await bindMemberSession(teamName, "worker", newSession, newMember.pendingLaunchId);

    const runtimeFile = paths.runtimeStatusPath(teamName, "worker");
    fs.mkdirSync(paths.teamDir(teamName) + "/runtime", { recursive: true });
    fs.writeFileSync(runtimeFile, JSON.stringify({
      teamName,
      agentName: "worker",
      membershipId: oldMember.membershipId,
      sessionFile: oldSession,
      ready: true,
      lastHeartbeatAt: Date.now(),
    }));

    const { toolsByName } = registerExtension();
    const result = await toolsByName.get("check_teammate")!.execute("check", {
      team_name: teamName,
      agent_name: "worker",
    }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "lead-session" },
    });
    expect(result.details).not.toHaveProperty("successfulTurnObserved");
    expect(result.details.runtime).toBeNull();
    expect(result.details.runtime?.membershipId).not.toBe(oldMember.membershipId);
  });
});

describe("identity P0: PID is observation, never binding authority", () => {
  it("does not bind an unrelated Session from a PID-only lead record", async () => {
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("TMUX", "");
    const teamName = uniqueTeam("pid-only");
    await teams.createTeam(teamName, "old-lead-session", "lead");
    fs.writeFileSync(paths.leadSessionPath(teamName), JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
    }));
    const before = fs.readFileSync(paths.leadSessionPath(teamName), "utf8");

    const { handlers } = registerExtension();
    const ctx = lifecycleContext(`/tmp/${teamName}-unrelated.jsonl`);
    await handlers.get("session_start")?.({ reason: "resume" }, ctx);

    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("pi-teams", expect.stringContaining(teamName));
    expect(fs.readFileSync(paths.leadSessionPath(teamName), "utf8")).toBe(before);
    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  });
});
