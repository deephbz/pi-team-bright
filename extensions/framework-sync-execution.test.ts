import { describe, expect, it, vi } from "vitest";
import {
  FRAMEWORK_SYNC_ACK_TYPE,
  FRAMEWORK_SYNC_SUPERSESSION_TYPE,
  FRAMEWORK_SYNC_ENTRY_TYPE,
  FRAMEWORK_SYNC_MESSAGE_TYPE,
  FrameworkSyncExecutionController,
  hasStructuredFrameworkSyncPair,
  persistedFrameworkSyncForPending,
  projectFrameworkSyncContext,
  projectFrameworkSyncMessage,
  validateFrameworkSyncRecord,
  makeFrameworkSyncRecord,
  type FrameworkSyncExecutionRecord,
} from "./framework-sync-execution";

const update = { kind: "updates", team_changes: [{ kind: "purpose", text: "Team purpose changed." }], worker_changes: [], task_changes: [], alerts: [] };

function harness(result: unknown = update) {
  let currentResult = result;
  let baselineAcknowledgedEntryId: string | null = null;
  let baselineCursor: string | null = "0";
  let membershipId = "member-1";
  const branch: any[] = [{ id: "root", type: "message" }];
  let sessionId = "session-a";
  let sessionFile = "/tmp/session-a.jsonl";
  let busy = false;
  const executeNow = vi.fn(async (_sessionId: string, _view: "updates" | "snapshot", _signal: AbortSignal, _callId: string) => currentResult);
  const notify = vi.fn();
  const clearPending = vi.fn();
  const readTeamBinding = vi.fn(async () => ({ epochId: "epoch-1", membershipId }));
  const pi = {
    appendEntry: vi.fn((customType: string, data: unknown) => branch.push({ id: `entry-${branch.length}`, type: "custom", customType, data })),
    sendMessage: vi.fn((message: any) => branch.push({ id: `message-${branch.length}`, type: "custom_message", customType: message.customType, details: message.details })),
  };
  const controller = new FrameworkSyncExecutionController({
    pi: pi as any,
    current: () => ({ sessionId, sessionFile, branch }),
    executeNow: (_id, _view, signal, callId) => executeNow(_id, _view, signal, callId),
    readTeamBinding,
    pendingObservation: () => (currentResult as any)?.kind === "quiet" ? undefined : {
      toolCallId: executeNow.mock.calls.at(-1)?.[3] ?? "", resultText: JSON.stringify(currentResult), epochId: "epoch-1", baselineCursor, baselineAcknowledgedEntryId,
    },
    setBranchContext: vi.fn(),
    clearPending,
    isBusy: () => busy,
    notify,
  });
  return { branch, pi, controller, executeNow, readTeamBinding, clearPending, notify, setResult: (value: unknown) => { currentResult = value; }, setMembership: (value: string) => { membershipId = value; }, setBaselineCursor: (value: string | null) => { baselineCursor = value; }, setBaselineAck: (value: string | null) => { baselineAcknowledgedEntryId = value; }, switchSession: () => { sessionId = "session-b"; sessionFile = "/tmp/session-b.jsonl"; }, setBusy: (value: boolean) => { busy = value; } };
}

describe("framework team_sync execution", () => {
  it.each(["indeterminate", "snapshot_required"])("refuses retired %s in framework execution records", async (kind) => {
    const test = harness();
    await test.controller.execute("alpha", "command");
    const record = test.branch[1].data as FrameworkSyncExecutionRecord;
    const old = { kind, message: "Historical observation.", state_changed: false, observation_advanced: false };
    record.result = old;
    record.resultText = JSON.stringify(old);
    expect(validateFrameworkSyncRecord(record)).toBeUndefined();
    const context = projectFrameworkSyncContext([{ role: "custom", customType: FRAMEWORK_SYNC_MESSAGE_TYPE, details: { recordId: record.id } }], test.branch, "session-a", "/tmp/session-a.jsonl");
    expect(context).toEqual([]);
    expect(projectFrameworkSyncMessage({ details: { recordId: record.id, record } })).toBeUndefined();
    expect(() => makeFrameworkSyncRecord({ ...record, result: old })).toThrow("snapshot or updates");
  });

  it("reads an acknowledgement persisted before the consuming assistant entry", async () => {
    const test = harness();
    await test.controller.execute("alpha", "automatic", "updates", "debt-1");
    const record = test.branch[1].data as FrameworkSyncExecutionRecord;
    test.pi.appendEntry(FRAMEWORK_SYNC_ACK_TYPE, { version: 1, recordId: record.id, acknowledgedEntryId: "entry-1", sessionId: "session-a", sessionFile: "/tmp/session-a.jsonl" });
    test.branch.push({ id: "assistant", type: "message", message: { role: "assistant", stopReason: "toolUse" } });
    const reloaded = structuredClone(test.branch);
    expect(persistedFrameworkSyncForPending(reloaded, "session-a", "/tmp/session-a.jsonl", record.toolCallId, record.resultText)?.record.id).toBe(record.id);
    const context = projectFrameworkSyncContext([{ role: "custom", customType: FRAMEWORK_SYNC_MESSAGE_TYPE, details: { recordId: record.id } }, { role: "assistant", content: [] }], reloaded, "session-a", "/tmp/session-a.jsonl");
    expect(context.map(message => message.role)).toEqual(["assistant", "toolResult", "assistant"]);
    expect(context[1].content[0].text).toBe(record.resultText);
    await test.controller.execute("alpha", "automatic", "updates", "debt-2");
    expect(test.branch.some(entry => entry.customType === FRAMEWORK_SYNC_SUPERSESSION_TYPE)).toBe(false);
  });
  it("reports an empty manual read in TUI and stays silent for an empty automatic read", async () => {
    const test = harness({ kind: "quiet" });
    expect(await test.controller.execute("alpha", "command")).toBe("quiet");
    expect(test.notify).toHaveBeenCalledWith("No Team updates.");
    test.notify.mockClear();
    expect(await test.controller.execute("alpha", "automatic", "updates", "debt-1")).toBe("quiet");
    expect(test.notify).not.toHaveBeenCalled();
    expect(test.pi.appendEntry).not.toHaveBeenCalled();
    expect(test.pi.sendMessage).not.toHaveBeenCalled();
    expect(test.executeNow).toHaveBeenCalledTimes(2);
  });

  it("persists the actual executor result and projects one framework-provenance pair", async () => {
    const test = harness();
    expect(await test.controller.execute("alpha", "automatic", "updates", "debt-1")).toBe("published");
    expect(test.executeNow).toHaveBeenCalledTimes(1);
    expect(test.pi.appendEntry).toHaveBeenCalledWith(FRAMEWORK_SYNC_ENTRY_TYPE, expect.objectContaining({ source: "automatic", debtKey: "debt-1", result: update }));
    expect(test.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: FRAMEWORK_SYNC_MESSAGE_TYPE, display: true, content: "" }), { triggerTurn: true, deliverAs: "followUp" });
    const record = test.branch[1].data as FrameworkSyncExecutionRecord;
    const custom = { role: "custom", customType: FRAMEWORK_SYNC_MESSAGE_TYPE, details: { recordId: record.id }, content: "", timestamp: record.recordedAt };
    const context = projectFrameworkSyncContext([custom, custom], test.branch, "session-a", "/tmp/session-a.jsonl");
    expect(context).toHaveLength(2);
    expect(context[0].role).toBe("assistant");
    expect(context[0].content[0].text).toContain("framework, not from the model");
    expect(context[0].content[1]).toMatchObject({ type: "toolCall", id: record.toolCallId, name: "team_sync", arguments: { view: "updates" } });
    expect(context[1]).toMatchObject({ role: "toolResult", toolCallId: record.toolCallId, content: [{ type: "text", text: record.resultText }] });
    const frameworkProjection = projectFrameworkSyncMessage({ details: { recordId: record.id, record } });
    expect(frameworkProjection?.source).toBe("Automatic");
    expect([frameworkProjection?.status, frameworkProjection?.summary, ...(frameworkProjection?.body ?? [])].join(" ")).toContain("1 Team change");
    expect(persistedFrameworkSyncForPending(test.branch, "session-a", "/tmp/session-a.jsonl", record.toolCallId, record.resultText)?.entryId).toBe(test.branch[1].id);
  });

  it("requires a structured provider call and matching result, not a text mention", async () => {
    const test = harness();
    await test.controller.execute("alpha", "command");
    const record = test.branch[1].data as FrameworkSyncExecutionRecord;
    expect(hasStructuredFrameworkSyncPair({ messages: [{ role: "user", content: `${record.toolCallId} ${record.resultText}` }] }, record)).toBe(false);
    expect(hasStructuredFrameworkSyncPair({ messages: [
      { role: "assistant", tool_calls: [{ id: record.toolCallId, function: { name: "team_sync", arguments: JSON.stringify(record.arguments) } }] },
      { role: "tool", tool_call_id: record.toolCallId, content: record.resultText },
    ] }, record)).toBe(true);
    expect(hasStructuredFrameworkSyncPair({ messages: [
      { role: "assistant", tool_calls: [{ id: record.toolCallId, function: { name: "team_sync" } }] },
      { role: "tool", tool_call_id: "other", content: record.resultText },
    ] }, record)).toBe(false);
  });

  it("drops a staged result when the Session switches during the read", async () => {
    let finish!: (value: unknown) => void;
    const test = harness();
    test.executeNow.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = test.controller.execute("alpha", "command");
    await Promise.resolve();
    await Promise.resolve();
    test.switchSession();
    finish(update);
    expect(await pending).toBe("skipped");
    expect(test.clearPending).toHaveBeenCalledOnce();
    expect(test.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("drops a staged result when compaction invalidates the in-flight call", async () => {
    let finish!: (value: unknown) => void;
    const test = harness();
    test.executeNow.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = test.controller.execute("alpha", "command");
    await Promise.resolve(); await Promise.resolve();
    test.controller.invalidate();
    finish(update);
    expect(await pending).toBe("skipped");
    expect(test.clearPending).toHaveBeenCalledOnce();
    expect(test.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("re-presents a staged record without a second authority read", async () => {
    const test = harness();
    await test.controller.execute("alpha", "automatic", "updates", "debt-1");
    const record = test.branch[1].data as FrameworkSyncExecutionRecord;
    expect(await test.controller.rePresent(record)).toBe(true);
    expect(test.executeNow).toHaveBeenCalledTimes(1);
    expect(test.pi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not re-present a failed result after leader Membership replacement", async () => {
    const test = harness();
    await test.controller.execute("alpha", "automatic", "updates", "debt-1");
    const record = test.branch[1].data as FrameworkSyncExecutionRecord;
    test.setMembership("member-2");
    expect(await test.controller.rePresent(record)).toBe(false);
    expect(test.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("serializes retry presentation with a manual sync and releases the guard after a read failure", async () => {
    const test = harness();
    await test.controller.execute("alpha", "automatic", "updates", "debt-1");
    const record = test.branch[1].data as FrameworkSyncExecutionRecord;
    let finish!: (binding: { epochId: string; membershipId: string }) => void;
    test.readTeamBinding.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const retry = test.controller.rePresent(record);
    expect(test.controller.isRunning).toBe(true);
    expect(await test.controller.rePresent(record)).toBe(false);
    expect(await test.controller.execute("alpha", "command")).toBe("skipped");
    expect(test.notify).toHaveBeenCalledWith("Team synchronization is already in progress.", "warning");
    expect(test.pi.sendMessage).toHaveBeenCalledTimes(1);
    finish({ epochId: "epoch-1", membershipId: "member-1" });
    expect(await retry).toBe(true);
    expect(test.pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(test.controller.isRunning).toBe(false);

    test.readTeamBinding.mockRejectedValueOnce(new Error("authority unavailable"));
    expect(await test.controller.rePresent(record)).toBe(false);
    expect(test.controller.isRunning).toBe(false);
    expect(await test.controller.rePresent(record)).toBe(true);
    expect(test.pi.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("supersedes an unacknowledged smaller result from the same hidden baseline", async () => {
    const test = harness();
    expect(await test.controller.execute("alpha", "command")).toBe("published");
    const first = test.branch[1].data as FrameworkSyncExecutionRecord;
    test.setResult({ ...update, team_changes: [...update.team_changes, { kind: "lifecycle", text: "Worker completed." }] });
    expect(await test.controller.execute("alpha", "command")).toBe("published");
    const records = test.branch.filter((entry) => entry.customType === FRAMEWORK_SYNC_ENTRY_TYPE).map((entry) => entry.data as FrameworkSyncExecutionRecord);
    expect(records).toHaveLength(2);
    expect(test.branch).toEqual(expect.arrayContaining([expect.objectContaining({ customType: "pi-team-bright.framework-sync-supersession", data: expect.objectContaining({ recordId: first.id, replacementRecordId: records[1].id }) })]));
    const messages = records.map((record) => ({ role: "custom", customType: FRAMEWORK_SYNC_MESSAGE_TYPE, details: { recordId: record.id }, content: "", timestamp: record.recordedAt }));
    const context = projectFrameworkSyncContext(messages, test.branch, "session-a", "/tmp/session-a.jsonl");
    expect(context).toHaveLength(2);
    expect(context[1].content[0].text).toBe(records[1].resultText);
  });

  it("keeps both results when an eventless acknowledgment changed the hidden baseline", async () => {
    const test = harness();
    await test.controller.execute("alpha", "command");
    test.setBaselineAck("native-ack-1");
    await test.controller.execute("alpha", "command");
    expect(test.branch.filter((entry) => entry.customType === "pi-team-bright.framework-sync-supersession")).toHaveLength(0);
  });

  it("publishes an initial snapshot with an explicit null baseline", async () => {
    const snapshot = { kind: "snapshot", team: { name: "alpha", purpose: "Plan release", lifecycle: "active" }, workers: [], tasks: [] };
    const test = harness(snapshot);
    test.setBaselineCursor(null);
    expect(await test.controller.execute("alpha", "command", "snapshot")).toBe("published");
    expect(test.branch[1].data).toMatchObject({ arguments: { view: "snapshot" }, baselineCursor: null, baselineAcknowledgedEntryId: null, result: snapshot });
  });
});
