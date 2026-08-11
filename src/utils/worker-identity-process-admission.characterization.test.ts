import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import * as paths from "./paths";
import * as runtime from "./runtime";
import * as teamEvents from "../coordination/event-journal";
import { DirectMessageDelivery } from "../alert-authority/direct-delivery";
import { TaskChangeDelivery } from "./task-delivery";
import * as teams from "./teams";

const testTeams: string[] = [];

function name(suffix: string): string {
  const teamName = `worker-identity-${suffix}-${process.pid}-${Date.now()}-${testTeams.length}`;
  testTeams.push(teamName);
  return teamName;
}

function context(sessionFile: string) {
  return {
    mode: "tui",
    isIdle: vi.fn(() => false),
    shutdown: vi.fn(),
    sessionManager: { getSessionFile: vi.fn(() => sessionFile) },
    ui: { notify: vi.fn(), setStatus: vi.fn(), setFooter: vi.fn() },
  };
}

function sessionStartHandler() {
  const handlers = new Map<string, (event: unknown, ctx: ReturnType<typeof context>) => Promise<void>>();
  piTeams({
    on(event: string, handler: (event: unknown, ctx: ReturnType<typeof context>) => Promise<void>) { handlers.set(event, handler); },
    registerTool() {},
    sendUserMessage() {},
  } as never);
  const handler = handlers.get("session_start");
  expect(handler).toBeDefined();
  return handler!;
}

async function createTeam(teamName: string): Promise<void> {
  await teams.createTeam(teamName, `/tmp/${teamName}-lead.jsonl`, `lead@${teamName}`);
  await teams.ensureLogicalWorker(teamName, {
    name: "worker",
    scope: "Preserve release-verification responsibility across carrier replacement.",
  });
}

function preparedMember(teamName: string, membershipId: string, launchId: string) {
  return {
    membershipId,
    pendingLaunchId: launchId,
    agentId: `worker@${teamName}`,
    name: "worker",
    agentType: "teammate" as const,
    joinedAt: 1,
    tmuxPaneId: "",
    cwd: process.cwd(),
    subscriptions: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const teamName of testTeams.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
});

describe("registered Worker identity and process-admission characterization", () => {
  it("keeps logical Worker meaning while a stopped Membership carrier is replaced and its exact new Session binds", async () => {
    vi.stubEnv("TMUX", "");
    const teamName = name("replacement");
    await createTeam(teamName);
    const scope = "Preserve release-verification responsibility across carrier replacement.";
    const oldMembershipId = teams.newMembershipId();
    const oldSession = `/tmp/${teamName}-old.jsonl`;
    await teams.addMember(teamName, {
      membershipId: oldMembershipId,
      agentId: `worker-old@${teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: 1,
      tmuxPaneId: "",
      sessionFile: oldSession,
      cwd: process.cwd(),
      subscriptions: [],
    });
    await runtime.writeRuntimeStatus(teamName, "worker", { pid: process.pid, startedAt: 1 }, oldMembershipId);

    // Replacement follows confirmed old-carrier cleanup. It must not mutate the
    // logical Worker record, and the new carrier needs its own launch capability.
    expect(await runtime.deleteRuntimeStatus(teamName, "worker", {
      membershipId: oldMembershipId, pid: process.pid, startedAt: 1,
    })).toBe(true);
    expect((await teams.deactivateMembership(teamName, oldMembershipId, "replaced"))?.membershipId).toBe(oldMembershipId);
    const replacementMembershipId = teams.newMembershipId();
    const launchId = teams.newLaunchId();
    await teams.addMember(teamName, preparedMember(teamName, replacementMembershipId, launchId));

    expect(await teams.readLogicalWorker(teamName, "worker")).toEqual({
      kind: "found", worker: { name: "worker", scope },
    });
    vi.stubEnv("PI_TEAM_NAME", teamName);
    vi.stubEnv("PI_AGENT_NAME", "worker");
    vi.stubEnv("PI_AGENT_LAUNCH_ID", launchId);
    const replacementSession = `/tmp/${teamName}-replacement.jsonl`;
    const ctx = context(replacementSession);
    await sessionStartHandler()({ reason: "startup" }, ctx);

    const config = await teams.readConfig(teamName);
    expect(config.logicalWorkers).toEqual([{ name: "worker", scope }]);
    expect(config.members.find((member) => member.membershipId === oldMembershipId)).toMatchObject({
      sessionFile: oldSession, isActive: false, deactivationReason: "replaced",
    });
    const replacement = config.members.find((member) => member.membershipId === replacementMembershipId);
    expect(replacement).toMatchObject({ sessionFile: replacementSession });
    expect(replacement?.pendingLaunchId).toBeUndefined();
    expect(await runtime.readRuntimeStatus(teamName, "worker")).toMatchObject({
      membershipId: replacementMembershipId, pid: process.pid, ready: false,
    });
    expect(teamEvents.readTeamEvents(teamName, { eventTypes: ["worker"] }).events).toEqual([
      expect.objectContaining({ worker: "worker", membershipId: replacementMembershipId, phase: "session_bound", generation: expect.objectContaining({ membershipId: replacementMembershipId, pid: process.pid }) }),
    ]);
    expect(ctx.shutdown).not.toHaveBeenCalled();
  });

  it("orders Worker runtime claim, exact binding, event evidence, and deliveries", async () => {
    vi.stubEnv("TMUX", "");
    const teamName = name("claim-bind-delivery-order");
    await createTeam(teamName);
    const membershipId = teams.newMembershipId();
    const launchId = teams.newLaunchId();
    const sessionFile = `/tmp/${teamName}-worker.jsonl`;
    await teams.addMember(teamName, preparedMember(teamName, membershipId, launchId));
    vi.stubEnv("PI_TEAM_NAME", teamName);
    vi.stubEnv("PI_AGENT_NAME", "worker");
    vi.stubEnv("PI_AGENT_LAUNCH_ID", launchId);
    const order: string[] = [];
    const writeRuntime = runtime.writeRuntimeStatus;
    const bind = teams.bindMemberSession;
    const append = teamEvents.appendTeamEvent;
    vi.spyOn(runtime, "writeRuntimeStatus").mockImplementation(async (...args) => {
      order.push("runtime_claim");
      return writeRuntime(...args);
    });
    vi.spyOn(teams, "bindMemberSession").mockImplementation(async (...args) => {
      expect(await runtime.readRuntimeStatus(teamName, "worker")).toMatchObject({ membershipId, pid: process.pid, ready: false });
      expect(teamEvents.readTeamEvents(teamName, { eventTypes: ["worker"] }).events).toEqual([]);
      order.push("session_bind");
      return bind(...args);
    });
    vi.spyOn(teamEvents, "appendTeamEvent").mockImplementation(async (...args) => {
      if (args[1].type === "worker" && args[1].phase === "session_bound") {
        expect((await teams.currentMembership(teamName, "worker"))).toMatchObject({ membershipId, sessionFile });
        order.push("session_bound_event");
      }
      return append(...args);
    });
    vi.spyOn(DirectMessageDelivery.prototype, "start").mockImplementation(async () => { order.push("direct_delivery_start"); });
    vi.spyOn(TaskChangeDelivery.prototype, "start").mockImplementation(async () => { order.push("task_delivery_start"); });

    const ctx = context(sessionFile);
    await sessionStartHandler()({ reason: "startup" }, ctx);
    expect(order).toEqual(["runtime_claim", "session_bind", "session_bound_event", "direct_delivery_start", "task_delivery_start"]);
    const runtimeBeforeReentry = fs.readFileSync(paths.runtimeStatusPath(teamName, "worker"), "utf8");
    await sessionStartHandler()({ reason: "resume" }, ctx);
    expect(fs.readFileSync(paths.runtimeStatusPath(teamName, "worker"), "utf8")).toBe(runtimeBeforeReentry);
    expect(order.filter((step) => step === "runtime_claim" || step === "session_bind" || step === "session_bound_event")).toHaveLength(3);
    expect(ctx.shutdown).not.toHaveBeenCalled();
  });

  it("refuses a live generation before binding, then admits recovery only after exact absence and replaces the durable generation", async () => {
    vi.stubEnv("TMUX", "");
    const teamName = name("admission");
    await createTeam(teamName);
    const membershipId = teams.newMembershipId();
    const launchId = teams.newLaunchId();
    await teams.addMember(teamName, preparedMember(teamName, membershipId, launchId));
    const sessionFile = `/tmp/${teamName}-worker.jsonl`;
    await runtime.writeRuntimeStatus(teamName, "worker", { pid: 47_001, startedAt: 7 }, membershipId);
    const before = fs.readFileSync(paths.runtimeStatusPath(teamName, "worker"), "utf8");

    vi.stubEnv("PI_TEAM_NAME", teamName);
    vi.stubEnv("PI_AGENT_NAME", "worker");
    vi.stubEnv("PI_AGENT_LAUNCH_ID", launchId);
    const probe = vi.spyOn(runtime, "probePidPresence").mockReturnValue("occupied");
    const refused = context(sessionFile);
    await sessionStartHandler()({ reason: "startup" }, refused);

    expect(refused.shutdown).toHaveBeenCalledOnce();
    expect(fs.readFileSync(paths.runtimeStatusPath(teamName, "worker"), "utf8")).toBe(before);
    const stillPrepared = await teams.currentMembership(teamName, "worker");
    expect(stillPrepared).toMatchObject({ membershipId, pendingLaunchId: launchId });
    expect(stillPrepared.sessionFile).toBeUndefined();
    expect(teamEvents.readTeamEvents(teamName, { eventTypes: ["worker"] }).events).toEqual([]);
    expect(probe).toHaveBeenCalledWith(47_001);

    probe.mockReturnValue("absent");
    const recovered = context(sessionFile);
    await sessionStartHandler()({ reason: "startup" }, recovered);

    const after = await runtime.readRuntimeStatus(teamName, "worker");
    expect(after).toMatchObject({ membershipId, pid: process.pid, ready: false });
    expect(after).not.toMatchObject({ pid: 47_001, startedAt: 7 });
    const bound = await teams.currentMembership(teamName, "worker");
    expect(bound).toMatchObject({ membershipId, sessionFile });
    expect(bound.pendingLaunchId).toBeUndefined();
    expect(teamEvents.readTeamEvents(teamName, { eventTypes: ["worker"] }).events).toEqual([
      expect.objectContaining({ membershipId, phase: "session_bound", generation: expect.objectContaining({ membershipId, pid: process.pid }) }),
    ]);
    expect(recovered.shutdown).not.toHaveBeenCalled();
  });
});
