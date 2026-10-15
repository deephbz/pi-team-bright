import { writeJsonFixture } from "./test-write-json";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { TEAM_UPDATE_TYPE } from "../../extensions/team-update";
import { DurableModelToolBindings, DurableModelToolCoordinationApplication } from "../model-tool-contract/durable-model-tool-port";
import * as paths from "./paths";
import * as runtime from "./runtime";
import * as teams from "./teams";

const names: string[] = [];
async function fixture(autoSyncEnabled: boolean) {
  const name = `framework-sync-${process.pid}-${Date.now()}-${names.length}`;
  names.push(name);
  const sessionFile = `/tmp/${name}.jsonl`;
  const config = await teams.createTeam(name, sessionFile, "lead-agent", "Framework sync test.",
    undefined, undefined, undefined, undefined, undefined, undefined,
    { waitSeconds: 120, autoSyncEnabled, autoSyncDelaySeconds: 0, autoSyncUpdateThreshold: 1, policyVersion: "test" });
  config.logicalWorkers = [{ name: "worker", scope: "test scope" }];
  writeJsonFixture(paths.configPath(name), config);
  const lead = config.members.find((member) => member.name === "team-lead")!;
  await runtime.writeRuntimeStatus(name, "team-lead", { pid: process.pid, startedAt: Date.now() }, lead.membershipId);
  vi.stubEnv("PI_AGENT_NAME", ""); vi.stubEnv("PI_TEAM_NAME", name);
  const branch: any[] = [{ id: "root", type: "message" }];
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const commands = new Map<string, any>();
  const sent: any[] = [];
  piTeams({
    registerTool() {}, registerMessageRenderer() {},
    registerCommand(command: string, options: any) { commands.set(command, options); },
    on(event: string, handler: (...args: any[]) => any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    appendEntry(customType: string, data: unknown) { branch.push({ id: `entry-${branch.length}`, type: "custom", customType, data }); },
    sendMessage(message: any) { sent.push(message); branch.push({ id: `message-${branch.length}`, type: "custom_message", customType: message.customType, details: message.details, content: message.content }); },
    sendUserMessage() {},
  } as never);
  const ctx = {
    model: { id: "test-model", provider: "test-provider", contextWindow: 10_000 },
    isIdle: vi.fn(() => true), hasPendingMessages: vi.fn(() => false),
    sessionManager: {
      getSessionFile: vi.fn(() => sessionFile), getSessionId: vi.fn(() => "session-1"), getBranch: vi.fn(() => branch),
      getEntries: vi.fn(() => branch), getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: { isUsingOAuth: vi.fn(() => false), getProvider: vi.fn(() => undefined) },
    getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 10_000, percent: 1 })),
    ui: { setFooter: vi.fn(), setStatus: vi.fn(), notify: vi.fn(), setTitle: vi.fn() },
  };
  const emit = async (event: string, value: unknown) => { for (const handler of handlers.get(event) ?? []) await handler(value, ctx); };
  return { name, sessionFile, config, lead, branch, commands, sent, ctx, emit, handlers };
}

afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const name of names.splice(0)) { fs.rmSync(paths.teamDir(name), { recursive: true, force: true }); fs.rmSync(paths.taskDir(name), { recursive: true, force: true }); }
});

describe("native lead Team updates", () => {
  it("does not register provider ACK or fabricate framework entries", async () => {
    const test = await fixture(false);
    expect(test.handlers.has("before_provider_request")).toBe(false);
    await test.emit("session_start", { reason: "resume" });
    vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readTeamSyncNow").mockResolvedValue({ kind: "quiet" });
    await test.commands.get("teamsync").handler("", test.ctx);
    expect(test.sent).toEqual([]);
    expect(test.branch).toHaveLength(1);
    await test.emit("session_shutdown", { reason: "quit" });
  });
  it("publishes one idle native page for a resumed bound Session", async () => {
    const test = await fixture(true);
    vi.useFakeTimers();
    vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readSyncNudgeDebt").mockResolvedValue({
      kind: "eligible", debtKey: "debt", scopeKey: "scope", updateCount: 1, requestedView: "updates",
      teamEpochId: test.config.epochId!, leaderSessionId: test.sessionFile, leaderMembershipId: test.lead.membershipId!,
      branchLineage: ["root"], branchId: "root", policyVersion: "test",
    });
    const read = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readTeamSyncNow").mockResolvedValue({
      kind: "updates", teamChanges: [], workerChanges: [{ worker: "worker", scope: "work", kind: "created", text: "Created." }], taskChanges: [], alerts: [], head: 1, epochId: test.config.epochId!,
    });
    vi.spyOn(DurableModelToolCoordinationApplication.prototype, "getPendingObservation").mockImplementation(() => {
      const call = read.mock.calls.at(-1);
      return call ? { sessionId: test.sessionFile, toolCallId: call[3], resultText: "", resultDigest: "", head: 1, epochId: test.config.epochId!, observation: { team: test.name, epoch: test.config.epochId!, binding: test.lead.membershipId!, from: 0, through: 1 } } : undefined;
    });
    await test.emit("session_start", { reason: "resume" });
    await vi.advanceTimersByTimeAsync(0);
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]).toMatchObject({ customType: TEAM_UPDATE_TYPE, details: { through: 1 } });
    expect(test.branch.filter(entry => entry.type === "custom")).toEqual([]);
    await test.emit("session_shutdown", { reason: "quit" });
  });
});
