import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { DurableModelToolTeamPort } from "../model-tool-contract/durable-model-tool-port";
import { exactLeaderSessionId } from "../model-tool-contract/runtime";
import * as paths from "./paths";
import * as runtime from "./runtime";
import * as teams from "./teams";
import type { TeamConfig } from "./models";

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

function registerExtension(branch: any[], sent: any[]) {
  const handlers = new Map<string, (...args: any[]) => any>();
  piTeams({
    registerTool() {},
    registerMessageRenderer() {},
    on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
    sendMessage(message: any) {
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

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const name of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
});

describe("resumed leader sync nudge binding", () => {
  it("binds the exact resumed Session before Worker-authored debt arms and presents once", async () => {
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
    const readDebt = vi.spyOn(DurableModelToolTeamPort.prototype, "readSyncNudgeDebt").mockResolvedValue({
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
    const bind = vi.spyOn(DurableModelToolTeamPort.prototype, "setLeaderSessionFile");
    const handlers = registerExtension(branch, sent);

    const resumedContext = context(sessionFile, sessionId, branch);
    await handlers.get("session_start")!({ reason: "resume" }, resumedContext);
    await settle();

    expect(bind).toHaveBeenCalledWith(sessionId, sessionFile);
    expect(readDebt).toHaveBeenCalledWith(sessionId, ["root"]);
    expect(bind.mock.invocationCallOrder[0]).toBeLessThan(readDebt.mock.invocationCallOrder[0]);
    expect(sent).toHaveLength(1);
    expect(sent[0].customType).toBe("pi-team-bright.sync-nudge");
    expect(branch.at(-1)?.details).toMatchObject({ kind: "presented", debtKey: "worker-authored-task-change" });

    await handlers.get("session_shutdown")!({ reason: "quit" }, context(sessionFile, sessionId, branch));
  });

  it("suppresses forked Sessions and real stale/unbound port bindings", async () => {
    const readDebt = vi.spyOn(DurableModelToolTeamPort.prototype, "readSyncNudgeDebt").mockResolvedValue({ kind: "eligible", debtKey: "must-not-read", requestedView: "updates", teamEpochId: "epoch", leaderSessionId: "session", leaderMembershipId: "membership", branchLineage: ["root"], branchId: "root", policyVersion: "test" });
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
    const stalePort = new DurableModelToolTeamPort();
    stalePort.setLeaderSessionFile(exactLeaderSessionId("stale-session"), `/tmp/${name}-stale.jsonl`);
    await expect(stalePort.readSyncNudgeDebt(exactLeaderSessionId("stale-session"), ["root"])).resolves.toEqual({ kind: "none" });
    const unboundPort = new DurableModelToolTeamPort();
    await expect(unboundPort.readSyncNudgeDebt(exactLeaderSessionId("unbound-session"), ["root"])).resolves.toEqual({ kind: "none" });
  });
});
