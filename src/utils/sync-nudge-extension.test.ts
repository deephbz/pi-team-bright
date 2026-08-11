import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { DurableModelToolBindings, DurableModelToolCoordinationApplication, DurableModelToolTeamPort } from "../model-tool-contract/durable-model-tool-port";
import { exactLeaderSessionId } from "../model-tool-contract/runtime";
import * as paths from "./paths";
import * as runtime from "./runtime";
import * as teams from "./teams";
import type { TeamConfig } from "./models";
import { readSyncNudgeRecords, readSyncNudges } from "./sync-nudge";
import { composedDurableModelToolPort } from "../../test/support/durable-model-tool-port";

const createdTeams: string[] = [];

function teamName(suffix: string): string {
  const name = `sync-nudge-extension-${suffix}-${process.pid}-${Date.now()}-${createdTeams.length}`;
  createdTeams.push(name);
  return name;
}

async function createTeam(name: string, sessionFile: string): Promise<TeamConfig> {
  const config = await teams.createTeam(
    name,
    sessionFile,
    "lead-agent",
    "Resumed nudge binding test.",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { waitSeconds: 120, nudgeEnabled: true, nudgeDelaySeconds: 0, policyVersion: "test" },
  );
  config.logicalWorkers = [{ name: "worker", scope: "test scope" }];
  teams.writeConfigAtomic(paths.configPath(name), config);
  return config;
}

function context(sessionFile: string, sessionId: string, branch: any[]) {
  return {
    model: { id: "test-model", provider: "test-provider", contextWindow: 10_000 },
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    sessionManager: {
      getSessionFile: vi.fn(() => sessionFile),
      getSessionId: vi.fn(() => sessionId),
      getBranch: vi.fn(() => branch),
      getEntries: vi.fn(() => branch),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: {
      isUsingOAuth: vi.fn(() => false),
      getProvider: vi.fn(() => undefined),
    },
    getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 10_000, percent: 1 })),
    ui: {
      setFooter: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
      setTitle: vi.fn(),
    },
  };
}

function registerExtension(branch: any[], sent: any[], beforeSend?: (message: any) => void) {
  const handlers = new Map<string, (...args: any[]) => any>();
  piTeams({
    registerTool() {},
    registerMessageRenderer() {},
    on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
    sendMessage(message: any) {
      beforeSend?.(message);
      sent.push(message);
      branch.push({
        id: `nudge-entry-${sent.length}`,
        type: "custom_message",
        timestamp: new Date().toISOString(),
        customType: message.customType,
        details: message.details,
      });
    },
    sendUserMessage() {},
  } as never);
  return handlers;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const name of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
});

describe("resumed leader sync nudge binding", () => {
  it("binds the exact resumed Session before Worker-authored debt arms and presents once", async () => {
    vi.useFakeTimers();
    const name = teamName("eligible");
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    const sessionId = `pi-session-${name}`;
    const config = await createTeam(name, sessionFile);
    const lead = config.members.find((member) => member.name === "team-lead")!;
    await runtime.writeRuntimeStatus(name, "team-lead", { pid: process.pid, startedAt: Date.now() }, lead.membershipId);
    const branch: any[] = [{ id: "root", type: "message", timestamp: new Date().toISOString() }];
    const sent: any[] = [];
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", name);
    const readDebt = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readSyncNudgeDebt").mockResolvedValue({
      kind: "eligible",
      debtKey: "worker-authored-task-change",
      requestedView: "updates",
      teamEpochId: config.epochId!,
      leaderSessionId: sessionFile,
      leaderMembershipId: lead.membershipId!,
      branchLineage: ["root"],
      branchId: "root",
      policyVersion: "test",
    });
    const bind = vi.spyOn(DurableModelToolBindings.prototype, "setLeaderSessionFile");
    const handlers = registerExtension(branch, sent);

    const resumedContext = context(sessionFile, sessionId, branch);
    await handlers.get("session_start")!({ reason: "resume" }, resumedContext);
    await vi.advanceTimersByTimeAsync(0);

    expect(bind).toHaveBeenCalledWith(sessionId, sessionFile);
    expect(readDebt).toHaveBeenCalledWith(sessionId, ["root"]);
    expect(bind.mock.invocationCallOrder[0]).toBeLessThan(readDebt.mock.invocationCallOrder[0]);
    expect(sent).toHaveLength(1);
    expect(sent[0].customType).toBe("pi-team-bright.sync-nudge");
    expect(branch.at(-1)?.details).toMatchObject({ kind: "presented", debtKey: "worker-authored-task-change" });

    await handlers.get("session_shutdown")!({ reason: "quit" }, context(sessionFile, sessionId, branch));
  });

  it("reserves before a lineage race and promotes only one fresh eligible nudge", async () => {
    vi.useFakeTimers();
    const name = teamName("lineage-race");
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    const sessionId = `pi-session-${name}`;
    const config = await createTeam(name, sessionFile);
    const lead = config.members.find((member) => member.name === "team-lead")!;
    await runtime.writeRuntimeStatus(name, "team-lead", { pid: process.pid, startedAt: Date.now() }, lead.membershipId);
    const branch: any[] = [{ id: "root", type: "message", timestamp: new Date().toISOString() }];
    const sent: any[] = [];
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", name);
    const stale = {
      kind: "eligible" as const, debtKey: "stale-debt", requestedView: "updates" as const,
      teamEpochId: config.epochId!, leaderSessionId: sessionFile, leaderMembershipId: lead.membershipId!,
      branchLineage: ["root"], branchId: "root", policyVersion: "test",
    };
    const fresh = {
      ...stale, debtKey: "fresh-debt", branchLineage: ["fork-root"], branchId: "fork-root",
    };
    vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readSyncNudgeDebt").mockImplementation(async (_session, lineage) =>
      lineage[0] === "root" ? stale : lineage[0] === "fork-root" ? fresh : { kind: "none" },
    );
    let raced = false;
    const handlers = registerExtension(branch, sent, () => {
      if (!raced) {
        raced = true;
        branch.splice(0, branch.length, { id: "fork-root", type: "message", timestamp: new Date().toISOString() });
      }
    });
    const resumed = context(sessionFile, sessionId, branch);

    await handlers.get("session_start")!({ reason: "resume" }, resumed);
    await vi.advanceTimersByTimeAsync(0);
    // The monitor is the deterministic producer hint for the fresh fork debt.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveLength(2);
    expect(readSyncNudgeRecords(name)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "reserved", debtKey: "stale-debt", branchLineage: ["root"] }),
      expect.objectContaining({ kind: "presented", debtKey: "fresh-debt", branchLineage: ["fork-root"] }),
    ]));
    expect(readSyncNudges(name)).toEqual([
      expect.objectContaining({ kind: "presented", debtKey: "fresh-debt", branchLineage: ["fork-root"] }),
    ]);
    expect(branch.filter((entry) => entry.type === "custom_message" && entry.details?.debtKey === "stale-debt")).toHaveLength(1);

    await handlers.get("session_shutdown")!({ reason: "quit" }, resumed);
  });

  it("suppresses a candidate after exact lead Membership replacement", async () => {
    vi.useFakeTimers();
    const name = teamName("lead-replaced");
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    const sessionId = `pi-session-${name}`;
    const config = await createTeam(name, sessionFile);
    const lead = config.members.find((member) => member.name === "team-lead")!;
    await runtime.writeRuntimeStatus(name, "team-lead", { pid: process.pid, startedAt: Date.now() }, lead.membershipId);
    const branch: any[] = [{ id: "root", type: "message", timestamp: new Date().toISOString() }];
    const sent: any[] = [];
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", name);
    vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readSyncNudgeDebt").mockResolvedValue({
      kind: "eligible", debtKey: "old-lead-debt", requestedView: "updates", teamEpochId: config.epochId!,
      leaderSessionId: sessionFile, leaderMembershipId: lead.membershipId!, branchLineage: ["root"], branchId: "root", policyVersion: "test",
    });
    const handlers = registerExtension(branch, sent);
    const resumed = context(sessionFile, sessionId, branch);

    await handlers.get("session_start")!({ reason: "resume" }, resumed);
    const replaced = await teams.readConfig(name);
    replaced.members = replaced.members.map((member) => member.name === "team-lead"
      ? { ...member, membershipId: "replacement-membership" }
      : member);
    teams.writeConfigAtomic(paths.configPath(name), replaced);
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toEqual([]);
    expect(readSyncNudgeRecords(name)).toEqual([]);
    await handlers.get("session_shutdown")!({ reason: "quit" }, resumed);
  });

  it("keeps a reservation unpresented when Pi Session nudge actuation fails", async () => {
    vi.useFakeTimers();
    const name = teamName("actuation-failure");
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    const sessionId = `pi-session-${name}`;
    const config = await createTeam(name, sessionFile);
    const lead = config.members.find((member) => member.name === "team-lead")!;
    await runtime.writeRuntimeStatus(name, "team-lead", { pid: process.pid, startedAt: Date.now() }, lead.membershipId);
    const branch: any[] = [{ id: "root", type: "message", timestamp: new Date().toISOString() }];
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", name);
    vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readSyncNudgeDebt").mockResolvedValue({
      kind: "eligible", debtKey: "failed-actuation", requestedView: "updates", teamEpochId: config.epochId!,
      leaderSessionId: sessionFile, leaderMembershipId: lead.membershipId!, branchLineage: ["root"], branchId: "root", policyVersion: "test",
    });
    const handlers = registerExtension(branch, [], () => { throw new Error("Pi Session send failed"); });
    const resumed = context(sessionFile, sessionId, branch);

    await handlers.get("session_start")!({ reason: "resume" }, resumed);
    await vi.advanceTimersByTimeAsync(0);

    expect(readSyncNudgeRecords(name)).toEqual([
      expect.objectContaining({ kind: "reserved", debtKey: "failed-actuation", branchLineage: ["root"] }),
    ]);
    expect(readSyncNudges(name)).toEqual([]);
    expect(branch).toHaveLength(1);

    await handlers.get("session_shutdown")!({ reason: "quit" }, resumed);
  });

  it("suppresses forked Sessions and real stale/unbound port bindings", async () => {
    const readDebt = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readSyncNudgeDebt").mockResolvedValue({ kind: "eligible", debtKey: "must-not-read", requestedView: "updates", teamEpochId: "epoch", leaderSessionId: "session", leaderMembershipId: "membership", branchLineage: ["root"], branchId: "root", policyVersion: "test" });
    const branch: any[] = [{ id: "root", type: "message", timestamp: new Date().toISOString() }];
    const sent: any[] = [];
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const handlers = registerExtension(branch, sent);

    await handlers.get("session_start")!({ reason: "fork" }, context("/tmp/fork.jsonl", "fork-session", branch));
    expect(readDebt).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    readDebt.mockRestore();

    const name = teamName("stale");
    const currentSession = `/tmp/${name}-current.jsonl`;
    await createTeam(name, currentSession);
    const stalePort = composedDurableModelToolPort();
    stalePort.setLeaderSessionFile(exactLeaderSessionId("stale-session"), `/tmp/${name}-stale.jsonl`);
    await expect(stalePort.readSyncNudgeDebt(exactLeaderSessionId("stale-session"), ["root"])).resolves.toEqual({ kind: "none" });
    const unboundPort = composedDurableModelToolPort();
    await expect(unboundPort.readSyncNudgeDebt(exactLeaderSessionId("unbound-session"), ["root"])).resolves.toEqual({ kind: "none" });
  });
});
