import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectModelToolTuiMessage } from "../src/model-tool-contract/tui-projection";
import { projectToolResult } from "../src/model-tool-contract/result-projection";
import type { PiTeamBrightTuiMessage } from "../src/model-tool-contract/tui-message-projection";

export const FRAMEWORK_SYNC_ENTRY_TYPE = "pi-team-bright.framework-sync-execution";
export const FRAMEWORK_SYNC_MESSAGE_TYPE = "pi-team-bright.framework-sync-result";
export const FRAMEWORK_SYNC_ACK_TYPE = "pi-team-bright.framework-sync-ack";
export const FRAMEWORK_SYNC_SUPERSESSION_TYPE = "pi-team-bright.framework-sync-supersession";

export interface FrameworkSyncExecutionRecord {
  version: 1;
  provenance: "pi-team-bright/framework";
  id: string;
  source: "command" | "automatic";
  debtKey?: string;
  epochId?: string;
  leaderMembershipId?: string;
  baselineCursor?: string | null;
  baselineAcknowledgedEntryId?: string | null;
  teamName: string;
  sessionId: string;
  sessionFile: string;
  branchLineage: string[];
  toolName: "team_sync";
  toolCallId: string;
  arguments: { view: "updates" | "snapshot" };
  result: unknown;
  resultText: string;
  recordedAt: number;
}

interface SessionEntryLike {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const sameIds = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((id, index) => id === right[index]);

export function validateFrameworkSyncRecord(value: unknown): FrameworkSyncExecutionRecord | undefined {
  if (!isObject(value) || value.version !== 1 || value.provenance !== "pi-team-bright/framework"
    || value.toolName !== "team_sync" || !["command", "automatic"].includes(String(value.source))
    || !["id", "teamName", "sessionId", "sessionFile", "toolCallId", "resultText"].every((key) => typeof value[key] === "string" && value[key] !== "")
    || !Array.isArray(value.branchLineage) || !value.branchLineage.every((id) => typeof id === "string")
    || (value.epochId !== undefined && (typeof value.epochId !== "string" || value.epochId === ""))
    || (value.leaderMembershipId !== undefined && (typeof value.leaderMembershipId !== "string" || value.leaderMembershipId === ""))
    || (value.baselineCursor !== undefined && value.baselineCursor !== null && typeof value.baselineCursor !== "string")
    || (value.baselineAcknowledgedEntryId !== undefined && value.baselineAcknowledgedEntryId !== null && typeof value.baselineAcknowledgedEntryId !== "string")
    || !isObject(value.arguments) || !["updates", "snapshot"].includes(String(value.arguments.view))
    || !Number.isFinite(value.recordedAt)) return undefined;
  try {
    if (JSON.stringify(projectToolResult("team_sync", value.result)) !== value.resultText) return undefined;
  } catch { return undefined; }
  return value as unknown as FrameworkSyncExecutionRecord;
}

export function makeFrameworkSyncRecord(input: Omit<FrameworkSyncExecutionRecord, "version" | "provenance" | "id" | "toolName" | "resultText" | "recordedAt">): FrameworkSyncExecutionRecord {
  const record: FrameworkSyncExecutionRecord = {
    version: 1,
    provenance: "pi-team-bright/framework",
    id: randomUUID(),
    ...input,
    branchLineage: [...input.branchLineage],
    toolName: "team_sync",
    arguments: { ...input.arguments },
    resultText: JSON.stringify(projectToolResult("team_sync", input.result)),
    recordedAt: Date.now(),
  };
  if (!validateFrameworkSyncRecord(record)) throw new Error("Framework team_sync result failed its public contract.");
  return record;
}

export function findFrameworkSyncRecord(branch: readonly SessionEntryLike[], recordId: string, sessionId: string, sessionFile: string): { entryId: string; record: FrameworkSyncExecutionRecord } | undefined {
  const index = branch.findIndex((entry) => entry.type === "custom" && entry.customType === FRAMEWORK_SYNC_ENTRY_TYPE && isObject(entry.data) && entry.data.id === recordId);
  if (index < 0) return undefined;
  const entry = branch[index];
  const record = validateFrameworkSyncRecord(entry.data);
  if (!record || record.sessionId !== sessionId || record.sessionFile !== sessionFile) return undefined;
  if (!sameIds(record.branchLineage, branch.slice(0, index).map((item) => item.id))) return undefined;
  return { entryId: entry.id, record };
}

function markedRecordIds(branch: readonly SessionEntryLike[], customType: string): Set<string> {
  return new Set(branch.filter((entry) => entry.type === "custom" && entry.customType === customType && isObject(entry.data) && typeof entry.data.recordId === "string")
    .map((entry) => (entry.data as Record<string, unknown>).recordId as string));
}

function effectiveSupersessionIds(branch: readonly SessionEntryLike[], sessionId: string, sessionFile: string): Set<string> {
  const ids = new Set<string>();
  for (const [index, entry] of branch.entries()) {
    if (entry.type !== "custom" || entry.customType !== FRAMEWORK_SYNC_SUPERSESSION_TYPE || !isObject(entry.data)) continue;
    const { recordId, replacementRecordId } = entry.data;
    if (typeof recordId !== "string" || typeof replacementRecordId !== "string") continue;
    const replacement = findFrameworkSyncRecord(branch, replacementRecordId, sessionId, sessionFile);
    if (!replacement) continue;
    if (branch.slice(index + 1).some((later) => later.type === "custom_message" && later.customType === FRAMEWORK_SYNC_MESSAGE_TYPE && isObject(later.details) && later.details.recordId === replacementRecordId)) ids.add(recordId);
  }
  return ids;
}

/** Keep old execution history, but replace an unacknowledged duplicate in provider context. */
function unresolvedDuplicateRecords(branch: readonly SessionEntryLike[], candidate: FrameworkSyncExecutionRecord): FrameworkSyncExecutionRecord[] {
  const acked = markedRecordIds(branch, FRAMEWORK_SYNC_ACK_TYPE);
  const superseded = effectiveSupersessionIds(branch, candidate.sessionId, candidate.sessionFile);
  return branch.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== FRAMEWORK_SYNC_ENTRY_TYPE || !isObject(entry.data) || typeof entry.data.id !== "string") return [];
    const found = findFrameworkSyncRecord(branch, entry.data.id, candidate.sessionId, candidate.sessionFile);
    const record = found?.record;
    return record && record.teamName === candidate.teamName && record.epochId && record.epochId === candidate.epochId
      && Object.hasOwn(record, "baselineAcknowledgedEntryId") && Object.hasOwn(candidate, "baselineAcknowledgedEntryId")
      && record.baselineCursor === candidate.baselineCursor && record.baselineAcknowledgedEntryId === candidate.baselineAcknowledgedEntryId
      && !acked.has(record.id) && !superseded.has(record.id) ? [record] : [];
  });
}

export function projectFrameworkSyncContext(messages: readonly any[], branch: readonly SessionEntryLike[], sessionId: string, sessionFile: string): any[] {
  const messagesByRecord = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "custom_message" || entry.customType !== FRAMEWORK_SYNC_MESSAGE_TYPE || !isObject(entry.details)) continue;
    if (typeof entry.details.recordId === "string") messagesByRecord.add(entry.details.recordId);
  }
  const seen = new Set<string>();
  const superseded = effectiveSupersessionIds(branch, sessionId, sessionFile);
  const projected: any[] = [];
  for (const message of messages) {
    if (message.role !== "custom" || message.customType !== FRAMEWORK_SYNC_MESSAGE_TYPE) {
      projected.push(message);
      continue;
    }
    const recordId = isObject(message.details) && typeof message.details.recordId === "string" ? message.details.recordId : "";
    const persisted = findFrameworkSyncRecord(branch, recordId, sessionId, sessionFile);
    if (!persisted || !messagesByRecord.has(recordId) || seen.has(recordId) || superseded.has(recordId)) continue;
    seen.add(recordId);
    const { record } = persisted;
    const timestamp = record.recordedAt;
    projected.push({
      role: "assistant",
      content: [
        { type: "text", text: "Pi Team Bright framework executed team_sync. This tool call came from the framework, not from the model." },
        { type: "toolCall", id: record.toolCallId, name: "team_sync", arguments: record.arguments },
      ],
      api: "openai-completions",
      provider: "pi-team-bright-framework",
      model: "framework-execution",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp,
    });
    projected.push({ role: "toolResult", toolCallId: record.toolCallId, toolName: "team_sync", content: [{ type: "text", text: record.resultText }], details: record.result, isError: false, timestamp });
  }
  return projected;
}

export function projectFrameworkSyncMessage(message: { details?: unknown }): PiTeamBrightTuiMessage | undefined {
  if (!isObject(message.details)) return undefined;
  const record = validateFrameworkSyncRecord(message.details.record);
  if (!record || message.details.recordId !== record.id) return undefined;
  const projection = projectModelToolTuiMessage("team_sync", JSON.parse(record.resultText), record.result);
  return { ...projection, lines: ["Framework team_sync execution", ...projection.lines], provenance: "tool-result" };
}

function providerNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(providerNodes);
  if (!isObject(value)) return [];
  return [value, ...Object.values(value).flatMap(providerNodes)];
}

/** Require a provider call and its matching result. A text mention alone cannot acknowledge the cursor. */
export function hasStructuredFrameworkSyncPair(payload: unknown, record: FrameworkSyncExecutionRecord): boolean {
  const nodes = providerNodes(payload);
  const call = nodes.some((node) => {
    if (node.type === "toolCall" && node.id === record.toolCallId && node.name === "team_sync") return true;
    if (node.type === "tool_use" && node.id === record.toolCallId && node.name === "team_sync") return true;
    if (node.id === record.toolCallId && isObject(node.function) && node.function.name === "team_sync") return true;
    if (node.call_id === record.toolCallId && node.name === "team_sync") return true;
    if (isObject(node.functionCall) && node.functionCall.name === "team_sync"
      && (node.functionCall.id === undefined || node.functionCall.id === record.toolCallId)
      && JSON.stringify(node.functionCall.args) === JSON.stringify(record.arguments)) return true;
    return false;
  });
  const result = nodes.some((node) => {
    if (node.role === "toolResult" && node.toolCallId === record.toolCallId) return JSON.stringify(node.content) === JSON.stringify([{ type: "text", text: record.resultText }]);
    if (node.role === "tool" && node.tool_call_id === record.toolCallId) return node.content === record.resultText;
    if (node.type === "tool_result" && node.tool_use_id === record.toolCallId) return providerNodes(node.content).some((item) => item.text === record.resultText);
    if (node.type === "function_call_output" && node.call_id === record.toolCallId) return node.output === record.resultText;
    if (isObject(node.functionResponse) && node.functionResponse.name === "team_sync"
      && (node.functionResponse.id === undefined || node.functionResponse.id === record.toolCallId)
      && isObject(node.functionResponse.response)) return node.functionResponse.response.output === record.resultText;
    return false;
  });
  return call && result;
}

export function persistedFrameworkSyncForPending(branch: readonly SessionEntryLike[], sessionId: string, sessionFile: string, toolCallId: string, resultText: string): { entryId: string; record: FrameworkSyncExecutionRecord } | undefined {
  for (const [index, entry] of branch.entries()) {
    if (entry.type !== "custom" || entry.customType !== FRAMEWORK_SYNC_ENTRY_TYPE || !isObject(entry.data) || typeof entry.data.id !== "string") continue;
    const persisted = findFrameworkSyncRecord(branch, entry.data.id, sessionId, sessionFile);
    if (persisted?.record.toolCallId === toolCallId && persisted.record.resultText === resultText
      && branch.slice(index + 1).some((later) => later.type === "custom_message" && later.customType === FRAMEWORK_SYNC_MESSAGE_TYPE && isObject(later.details) && later.details.recordId === persisted.record.id)) return persisted;
  }
  return undefined;
}

export interface FrameworkSyncExecutionDependencies {
  pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">;
  current: () => { sessionId: string; sessionFile: string; branch: SessionEntryLike[] } | undefined;
  executeNow: (sessionId: string, view: "updates" | "snapshot", signal: AbortSignal, toolCallId: string) => Promise<unknown>;
  readTeamBinding: (teamName: string, sessionFile: string) => Promise<{ epochId: string; membershipId: string } | undefined>;
  pendingObservation: (sessionId: string) => { toolCallId: string; resultText: string; epochId: string; baselineCursor?: string | null; baselineAcknowledgedEntryId?: string | null } | undefined;
  setBranchContext: (sessionId: string, branch: string[]) => void;
  clearPending: (sessionId: string, toolCallId: string) => void;
  isBusy: (ownToolCallId?: string) => boolean;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
}

/** A single framework call. Pi owns Session persistence through its public extension API. */
export class FrameworkSyncExecutionController {
  private running = false;
  private generation = 0;
  private currentAbort?: AbortController;
  private lastAutomaticFailure?: string;

  constructor(private readonly dependencies: FrameworkSyncExecutionDependencies) {}

  invalidate(): void { this.generation++; this.currentAbort?.abort(); this.lastAutomaticFailure = undefined; }
  get isRunning(): boolean { return this.running; }

  /** Retry presentation of the same staged observation after a failed provider turn. */
  async rePresent(record: FrameworkSyncExecutionRecord): Promise<boolean> {
    const start = this.dependencies.current();
    const generation = this.generation;
    if (this.running || !start || start.sessionId !== record.sessionId || start.sessionFile !== record.sessionFile
      || !record.epochId || !record.leaderMembershipId || this.dependencies.isBusy(record.toolCallId)
      || !findFrameworkSyncRecord(start.branch, record.id, start.sessionId, start.sessionFile)) return false;
    this.running = true;
    try {
      const binding = await this.dependencies.readTeamBinding(record.teamName, record.sessionFile);
      const current = this.dependencies.current();
      if (!binding || binding.epochId !== record.epochId || binding.membershipId !== record.leaderMembershipId
        || generation !== this.generation || !current || current.sessionId !== start.sessionId || current.sessionFile !== start.sessionFile
        || !sameIds(start.branch.map((entry) => entry.id), current.branch.map((entry) => entry.id))
        || this.dependencies.isBusy(record.toolCallId)) return false;
      this.dependencies.pi.sendMessage({ customType: FRAMEWORK_SYNC_MESSAGE_TYPE, content: "", display: true, details: { recordId: record.id, record } }, { triggerTurn: true, deliverAs: "followUp" });
      return true;
    } catch { return false; }
    finally { this.running = false; }
  }

  async execute(teamName: string, source: "command" | "automatic", view: "updates" | "snapshot" = "updates", debtKey?: string): Promise<"published" | "quiet" | "skipped" | "failed"> {
    if (this.running || this.dependencies.isBusy()) {
      if (source === "command") this.dependencies.notify(this.running ? "Team synchronization is already in progress." : "Leader is busy; retry /teamsync when idle.", "warning");
      return "skipped";
    }
    const start = this.dependencies.current();
    if (!start) return "skipped";
    const generation = this.generation;
    this.running = true;
    const toolCallId = `framework-team-sync-${randomUUID()}`;
    const signal = new AbortController();
    this.currentAbort = signal;
    const sameSession = () => {
      const current = this.dependencies.current();
      return current && generation === this.generation && current.sessionId === start.sessionId
        && current.sessionFile === start.sessionFile && sameIds(current.branch.map((entry) => entry.id), start.branch.map((entry) => entry.id));
    };
    try {
      const binding = await this.dependencies.readTeamBinding(teamName, start.sessionFile);
      if (!binding || !sameSession() || this.dependencies.isBusy()) return "skipped";
      this.dependencies.setBranchContext(start.sessionId, start.branch.map((entry) => entry.id));
      const result = await this.dependencies.executeNow(start.sessionId, view, signal.signal, toolCallId);
      if (!sameSession() || this.dependencies.isBusy(toolCallId)) {
        this.dependencies.clearPending(start.sessionId, toolCallId);
        return "skipped";
      }
      const currentBinding = await this.dependencies.readTeamBinding(teamName, start.sessionFile);
      if (!currentBinding || currentBinding.epochId !== binding.epochId || currentBinding.membershipId !== binding.membershipId
        || !sameSession() || this.dependencies.isBusy(toolCallId)) {
        this.dependencies.clearPending(start.sessionId, toolCallId);
        return "skipped";
      }
      if (isObject(result) && result.kind === "quiet") {
        this.lastAutomaticFailure = undefined;
        if (source === "command") this.dependencies.notify("No Team updates.");
        return "quiet";
      }
      if (!isObject(result) || !["updates", "snapshot"].includes(String(result.kind))) {
        this.dependencies.clearPending(start.sessionId, toolCallId);
        const message = "Team synchronization is unavailable. Use team_sync for a snapshot or inspect Team status.";
        if (source === "command" || this.lastAutomaticFailure !== message) this.dependencies.notify(message, "warning");
        if (source === "automatic") this.lastAutomaticFailure = message;
        return "failed";
      }
      const changes = result.kind === "snapshot" ? 1 : ["team_changes", "worker_changes", "task_changes", "alerts"].reduce((total, key) => total + (Array.isArray(result[key]) ? result[key].length : 0), 0);
      if (result.kind === "updates" && changes === 0) {
        this.lastAutomaticFailure = undefined;
        this.dependencies.clearPending(start.sessionId, toolCallId);
        if (source === "command") this.dependencies.notify("No Team updates.");
        return "quiet";
      }
      this.lastAutomaticFailure = undefined;
      const pending = this.dependencies.pendingObservation(start.sessionId);
      if (!pending || pending.toolCallId !== toolCallId || pending.epochId !== binding.epochId
        || pending.resultText !== JSON.stringify(projectToolResult("team_sync", result))) {
        this.dependencies.clearPending(start.sessionId, toolCallId);
        return "skipped";
      }
      const record = makeFrameworkSyncRecord({ source, ...(debtKey ? { debtKey } : {}), teamName, epochId: binding.epochId, leaderMembershipId: binding.membershipId,
        ...(pending.baselineCursor !== undefined ? { baselineCursor: pending.baselineCursor } : {}),
        ...(pending.baselineAcknowledgedEntryId !== undefined ? { baselineAcknowledgedEntryId: pending.baselineAcknowledgedEntryId } : {}),
        sessionId: start.sessionId, sessionFile: start.sessionFile, branchLineage: start.branch.map((entry) => entry.id), toolCallId, arguments: { view }, result });
      const duplicates = unresolvedDuplicateRecords(start.branch, record);
      this.dependencies.pi.appendEntry(FRAMEWORK_SYNC_ENTRY_TYPE, record);
      for (const prior of duplicates) this.dependencies.pi.appendEntry(FRAMEWORK_SYNC_SUPERSESSION_TYPE, {
        version: 1, recordId: prior.id, replacementRecordId: record.id, sessionId: start.sessionId, sessionFile: start.sessionFile,
      });
      const afterAppend = this.dependencies.current();
      if (!afterAppend || generation !== this.generation || afterAppend.sessionId !== start.sessionId || afterAppend.sessionFile !== start.sessionFile
        || !findFrameworkSyncRecord(afterAppend.branch, record.id, start.sessionId, start.sessionFile)) {
        this.dependencies.clearPending(start.sessionId, toolCallId);
        return "skipped";
      }
      this.dependencies.pi.sendMessage({ customType: FRAMEWORK_SYNC_MESSAGE_TYPE, content: "", display: true, details: { recordId: record.id, record } }, { triggerTurn: true, deliverAs: "followUp" });
      return "published";
    } catch (error) {
      this.dependencies.clearPending(start.sessionId, toolCallId);
      const message = `Team synchronization failed: ${error instanceof Error ? error.message : String(error)}`;
      if (source === "command" || this.lastAutomaticFailure !== message) this.dependencies.notify(message, "error");
      if (source === "automatic") this.lastAutomaticFailure = message;
      return "failed";
    } finally { this.running = false; if (this.currentAbort === signal) this.currentAbort = undefined; }
  }
}
