import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { FRAMEWORK_SYNC_ENTRY_TYPE, FRAMEWORK_SYNC_MESSAGE_TYPE, makeFrameworkSyncRecord } from "../../extensions/framework-sync-execution";
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
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { waitSeconds: 120, autoSyncEnabled, autoSyncDelaySeconds: 0, autoSyncUpdateThreshold: 1, policyVersion: "test" });
  config.logicalWorkers = [{ name: "worker", scope: "test scope" }];
  teams.writeConfigAtomic(paths.configPath(name), config);
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
    sendMessage(message: any) { sent.push(message); branch.push({ id: `message-${branch.length}`, type: "custom_message", customType: message.customType, details: message.details }); },
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
  return { name, sessionFile, config, lead, branch, commands, sent, ctx, emit };
}

afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const name of names.splice(0)) { fs.rmSync(paths.teamDir(name), { recursive: true, force: true }); fs.rmSync(paths.taskDir(name), { recursive: true, force: true }); }
});

describe("leader framework team synchronization", () => {
  it.each(["valid", "absent", "branch", "text", "false", "throw", "replacement"])("resolves a captured native candidate on %s proof", async (failure) => {
    const test = await fixture(false);
    await test.emit("session_start", { reason: "resume" });
    const resultText = JSON.stringify({ kind: "caught_up", head: 0, epoch_id: "epoch" });
    test.branch.push({ id: "native-result", type: "message", message: { role: "toolResult", toolCallId: "native", content: [{ type: "text", text: resultText }] } });
    const pending = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "getPendingObservation").mockReturnValue({ sessionId: test.sessionFile, toolCallId: "native", resultText, resultDigest: "", head: 0, epochId: test.config.epochId! });
    const ack = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "acknowledgePendingObservationAsync").mockResolvedValue(failure !== "false");
    if (failure === "throw") ack.mockRejectedValue(new Error("hidden commit failed"));
    const discard = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "discardPendingObservation");
    await test.emit("before_provider_request", { payload: failure === "absent" ? {} : { content: resultText } });
    if (failure === "branch") test.branch[0] = { id: "replacement", type: "message" };
    if (failure === "text") test.branch[1].message.content[0].text = "changed";
    if (failure === "replacement") pending.mockReturnValue({ sessionId: test.sessionFile, toolCallId: "later", resultText: "later", resultDigest: "", head: 1, epochId: test.config.epochId! });
    await test.emit("message_end", { message: { role: "assistant", stopReason: "toolUse" } });
    if (failure === "valid") {
      expect(ack).toHaveBeenCalledWith("session-1", "native-result", ["root", "native-result"]);
      expect(discard).not.toHaveBeenCalled();
    } else expect(discard).toHaveBeenCalledWith("session-1", "native");
    if (["absent", "branch", "text", "replacement"].includes(failure)) expect(ack).not.toHaveBeenCalled();
    await test.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
    expect(ack.mock.calls.length).toBe(["valid", "false", "throw"].includes(failure) ? 1 : 0);
    await test.emit("session_shutdown", { reason: "quit" });
  });
  it("runs /teamsync once without a model turn when no updates exist", async () => {
    const test = await fixture(false);
    vi.spyOn(DurableModelToolCoordinationApplication.prototype, "selectTeamSyncView").mockResolvedValue("updates");
    const read = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readTeamSyncNow").mockResolvedValue({ kind: "quiet" });
    await test.emit("session_start", { reason: "resume" });
    await test.commands.get("teamsync").handler("", test.ctx);
    expect(read).toHaveBeenCalledTimes(1);
    expect(test.ctx.ui.notify).toHaveBeenCalledWith("No Team updates.", "info");
    expect(test.sent).toEqual([]);
    expect(test.branch).toHaveLength(1);
    await test.emit("session_shutdown", { reason: "quit" });
  });

  it("binds the resumed Session and publishes one actual result when automatic debt is due", async () => {
    const bind = vi.spyOn(DurableModelToolBindings.prototype, "setLeaderSessionFile");
    const test = await fixture(true);
    vi.useFakeTimers();
    const debt = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readSyncNudgeDebt").mockResolvedValue({
      kind: "eligible", debtKey: "debt-1", scopeKey: "scope-1", updateCount: 1, requestedView: "updates",
      teamEpochId: test.config.epochId!, leaderSessionId: test.sessionFile, leaderMembershipId: test.lead.membershipId!,
      branchLineage: ["root"], branchId: "root", policyVersion: "test",
    });
    const read = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readTeamSyncNow").mockResolvedValue({
      kind: "updates", teamChanges: [{ kind: "purpose", text: "Changed." }], workerChanges: [], taskChanges: [], alerts: [], head: 1, epochId: test.config.epochId!,
    });
    vi.spyOn(DurableModelToolCoordinationApplication.prototype, "getPendingObservation").mockImplementation(() => {
      const call = read.mock.calls.at(-1);
      return call ? { sessionId: test.sessionFile, toolCallId: call[3], resultText: JSON.stringify({ kind: "updates", team_changes: [{ kind: "purpose", text: "Changed." }], worker_changes: [], task_changes: [], alerts: [] }), resultDigest: "digest", head: 1, epochId: test.config.epochId!, baselineCursor: "0", baselineAcknowledgedEntryId: null } : undefined;
    });
    await test.emit("session_start", { reason: "resume" });
    await vi.advanceTimersByTimeAsync(0);
    expect(bind).toHaveBeenCalledWith("session-1", test.sessionFile);
    expect(debt).toHaveBeenCalledWith("session-1", ["root"]);
    expect(bind.mock.invocationCallOrder[0]).toBeLessThan(debt.mock.invocationCallOrder[0]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0].customType).toBe("pi-team-bright.framework-sync-result");
    expect(test.branch[1].data).toMatchObject({ provenance: "pi-team-bright/framework", source: "automatic", debtKey: "debt-1", result: { kind: "updates" } });
    await test.emit("session_shutdown", { reason: "quit" });
  });

  it("does not execute after the lead Membership changes", async () => {
    const test = await fixture(true);
    vi.useFakeTimers();
    vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readSyncNudgeDebt").mockResolvedValue({
      kind: "eligible", debtKey: "debt-1", scopeKey: "scope-1", updateCount: 1, requestedView: "updates",
      teamEpochId: test.config.epochId!, leaderSessionId: test.sessionFile, leaderMembershipId: test.lead.membershipId!,
      branchLineage: ["root"], branchId: "root", policyVersion: "test",
    });
    const read = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readTeamSyncNow").mockResolvedValue({ kind: "quiet" });
    const changed = structuredClone(test.config);
    changed.members = changed.members.map((member) => member.name === "team-lead" ? { ...member, membershipId: "new-membership" } : member);
    teams.writeConfigAtomic(paths.configPath(test.name), changed);
    await test.emit("session_start", { reason: "resume" });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).not.toHaveBeenCalled();
    expect(test.sent).toEqual([]);
    await test.emit("session_shutdown", { reason: "quit" });
  });

  it("does not repeat an automatic empty race or show its quiet notice", async () => {
    const test = await fixture(true);
    vi.useFakeTimers();
    vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readSyncNudgeDebt").mockResolvedValue({
      kind: "eligible", debtKey: "stale-debt", scopeKey: "scope-1", updateCount: 1, requestedView: "updates",
      teamEpochId: test.config.epochId!, leaderSessionId: test.sessionFile, leaderMembershipId: test.lead.membershipId!,
      branchLineage: ["root"], branchId: "root", policyVersion: "test",
    });
    const read = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "readTeamSyncNow").mockResolvedValue({ kind: "quiet" });
    await test.emit("session_start", { reason: "resume" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(test.sent).toEqual([]);
    expect(test.ctx.ui.notify).not.toHaveBeenCalledWith("No Team updates.", "info");
    await test.emit("session_shutdown", { reason: "quit" });
  });

  it("acknowledges a framework result at assistant message_end before tool execution", async () => {
    const test = await fixture(false);
    await test.emit("session_start", { reason: "resume" });
    const record = makeFrameworkSyncRecord({ source: "command", teamName: test.name, sessionId: "session-1", sessionFile: test.sessionFile,
      branchLineage: ["root"], toolCallId: "framework-team-sync-test", arguments: { view: "updates" },
      result: { kind: "updates", team_changes: [{ kind: "purpose", text: "Changed." }], worker_changes: [], task_changes: [], alerts: [] } });
    test.branch.push({ id: "framework-entry", type: "custom", customType: FRAMEWORK_SYNC_ENTRY_TYPE, data: record });
    test.branch.push({ id: "framework-message", type: "custom_message", customType: FRAMEWORK_SYNC_MESSAGE_TYPE, details: { recordId: record.id, record } });
    vi.spyOn(DurableModelToolCoordinationApplication.prototype, "getPendingObservation").mockReturnValue({ sessionId: test.sessionFile, toolCallId: record.toolCallId, resultText: record.resultText, resultDigest: "digest", head: 1, epochId: test.config.epochId! });
    const ack = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "acknowledgePendingObservationAsync").mockResolvedValue(true);
    const payload = { messages: [
      { role: "assistant", tool_calls: [{ id: record.toolCallId, function: { name: "team_sync", arguments: JSON.stringify(record.arguments) } }] },
      { role: "tool", tool_call_id: record.toolCallId, content: record.resultText },
    ] };
    await test.emit("before_provider_request", { payload });
    expect(ack).not.toHaveBeenCalled();
    await test.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
    expect(ack).toHaveBeenCalledWith("session-1", "framework-entry", ["root", "framework-entry", "framework-message"]);
    await test.emit("session_shutdown", { reason: "quit" });
  });

  it("keeps an error turn unacknowledged and releases its pending manual observation", async () => {
    const test = await fixture(false);
    await test.emit("session_start", { reason: "resume" });
    const record = makeFrameworkSyncRecord({ source: "command", teamName: test.name, sessionId: "session-1", sessionFile: test.sessionFile,
      branchLineage: ["root"], toolCallId: "framework-team-sync-error", arguments: { view: "updates" },
      result: { kind: "updates", team_changes: [{ kind: "purpose", text: "Changed." }], worker_changes: [], task_changes: [], alerts: [] } });
    test.branch.push({ id: "framework-entry", type: "custom", customType: FRAMEWORK_SYNC_ENTRY_TYPE, data: record });
    test.branch.push({ id: "framework-message", type: "custom_message", customType: FRAMEWORK_SYNC_MESSAGE_TYPE, details: { recordId: record.id, record } });
    vi.spyOn(DurableModelToolCoordinationApplication.prototype, "getPendingObservation").mockReturnValue({ sessionId: test.sessionFile, toolCallId: record.toolCallId, resultText: record.resultText, resultDigest: "digest", head: 1, epochId: test.config.epochId! });
    const ack = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "acknowledgePendingObservationAsync").mockResolvedValue(true);
    const discard = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "discardPendingObservation");
    await test.emit("before_provider_request", { payload: { messages: [
      { role: "assistant", tool_calls: [{ id: record.toolCallId, function: { name: "team_sync" } }] },
      { role: "tool", tool_call_id: record.toolCallId, content: record.resultText },
    ] } });
    await test.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
    await test.emit("turn_end", { message: { role: "assistant", stopReason: "error" } });
    expect(ack).not.toHaveBeenCalled();
    await test.emit("agent_settled", {});
    expect(discard).toHaveBeenCalledWith("session-1", record.toolCallId);
    expect(test.ctx.ui.notify).toHaveBeenCalledWith("Team synchronization failed. Run /teamsync to retry.", "warning");
    await test.emit("session_shutdown", { reason: "quit" });
  });

  it("re-presents one automatic error once, then stops without a retry loop", async () => {
    const test = await fixture(false);
    await test.emit("session_start", { reason: "resume" });
    vi.useFakeTimers();
    const record = makeFrameworkSyncRecord({ source: "automatic", debtKey: "debt-1", teamName: test.name,
      epochId: test.config.epochId!, leaderMembershipId: test.lead.membershipId!,
      sessionId: "session-1", sessionFile: test.sessionFile, branchLineage: ["root"], toolCallId: "framework-team-sync-retry",
      arguments: { view: "updates" }, result: { kind: "updates", team_changes: [{ kind: "purpose", text: "Changed." }], worker_changes: [], task_changes: [], alerts: [] } });
    test.branch.push({ id: "framework-entry", type: "custom", customType: FRAMEWORK_SYNC_ENTRY_TYPE, data: record });
    test.branch.push({ id: "framework-message", type: "custom_message", customType: FRAMEWORK_SYNC_MESSAGE_TYPE, details: { recordId: record.id, record } });
    vi.spyOn(DurableModelToolCoordinationApplication.prototype, "getPendingObservation").mockReturnValue({ sessionId: test.sessionFile, toolCallId: record.toolCallId, resultText: record.resultText, resultDigest: "digest", head: 1, epochId: test.config.epochId! });
    const discard = vi.spyOn(DurableModelToolCoordinationApplication.prototype, "discardPendingObservation");
    await test.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
    await test.emit("turn_end", { message: { role: "assistant", stopReason: "error" } });
    await test.emit("agent_settled", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0].details.recordId).toBe(record.id);
    expect(discard).not.toHaveBeenCalled();
    await test.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
    await test.emit("turn_end", { message: { role: "assistant", stopReason: "error" } });
    await test.emit("agent_settled", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(test.sent).toHaveLength(1);
    expect(discard).toHaveBeenCalledOnce();
    expect(test.ctx.ui.notify).toHaveBeenCalledWith("Automatic Team synchronization stopped after one retry. Run /teamsync to retry.", "warning");
    await test.emit("session_shutdown", { reason: "quit" });
  });
});
