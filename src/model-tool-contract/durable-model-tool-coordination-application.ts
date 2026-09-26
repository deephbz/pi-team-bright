import { CoordinationObservationService, type CoordinationObservationContext } from "../coordination/observation-service";
import type { ModelToolCoordinationApplicationPort } from "./model-tool-journey-port";
import type { ExactLeaderSessionId, PendingObservation, TeamSnapshotPortResult, TeamSyncPortResult } from "./model-tool-contracts";
import type { SyncNudgeDebt } from "../utils/sync-nudge-conductor";
import { DurableModelToolBindings } from "./durable-model-tool-bindings";
export class DurableModelToolCoordinationApplication implements ModelToolCoordinationApplicationPort {
  constructor(private readonly bindings: DurableModelToolBindings, private readonly service: CoordinationObservationService) {}
  private observationContext(id: ExactLeaderSessionId): CoordinationObservationContext | undefined { return this.bindings.launchContext(id); }
  async readSnapshot(id: ExactLeaderSessionId): Promise<TeamSnapshotPortResult> { const file = this.bindings.sessionFile(id); const context = this.observationContext(id); return file ? this.service.readSnapshot(file, context) : { kind: "no_active_team" }; }
  async readTeamSync(id: ExactLeaderSessionId, view: "snapshot" | "updates", signal: AbortSignal, call: string): Promise<TeamSyncPortResult> { const file = this.bindings.sessionFile(id); const context = this.observationContext(id); return file ? this.service.readTeamSync(file, view, signal, call, context) : { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." }; }
  async readTeamSyncNow(id: ExactLeaderSessionId, view: "snapshot" | "updates", signal: AbortSignal, call: string) { const file = this.bindings.sessionFile(id); const context = this.observationContext(id); return file ? this.service.readTeamSyncNow(file, view, signal, call, context) : { kind: "unavailable" as const, reason: "no_active_team" as const, message: "The exact leader Session is not bound to an active Team." }; }
  async peekTeamSync(id: ExactLeaderSessionId, view: "snapshot" | "updates", lineage: string[]) { const file = this.bindings.sessionFile(id); return file ? this.service.peekTeamSync(file, view, lineage) : { kind: "unavailable" as const, reason: "no_active_team" as const, message: "The exact leader Session is not bound to an active Team." }; }
  async selectTeamSyncView(id: ExactLeaderSessionId, lineage: string[]) { const file = this.bindings.sessionFile(id); return file ? this.service.selectTeamSyncView(file, lineage) : "snapshot" as const; }
  discardPendingObservation(id: ExactLeaderSessionId, call: string): void { this.service.discardPending(this.bindings.sessionFile(id) ?? id, call); }
  async readSyncNudgeDebt(id: ExactLeaderSessionId, lineage: string[]): Promise<SyncNudgeDebt> { const file = this.bindings.sessionFile(id); return file ? this.service.readSyncNudgeDebt(file, lineage) : { kind: "none" }; }
  setPendingObservationResult(id: ExactLeaderSessionId, result: unknown): void { this.service.setPendingResult(this.bindings.sessionFile(id) ?? id, result); }
  acknowledgePendingObservation(_id: ExactLeaderSessionId, _entry: string, _branch: string[]): boolean { return false; }
  acknowledgePendingObservationAsync(id: ExactLeaderSessionId, entry: string, branch: string[]): Promise<boolean> { return this.service.acknowledge(this.bindings.sessionFile(id) ?? id, entry, branch); }
  setBranchContext(id: ExactLeaderSessionId, branch: string[]): void { this.service.setBranchContext(this.bindings.sessionFile(id) ?? id, branch); }
  getPendingObservation(id: ExactLeaderSessionId): PendingObservation | undefined { const pending = this.service.pending(this.bindings.sessionFile(id) ?? id); return pending ? { sessionId: pending.sessionId, toolCallId: pending.toolCallId, resultText: pending.resultText, resultDigest: pending.resultDigest, head: pending.head, epochId: pending.epochId, baselineCursor: pending.baselineCursor, baselineAcknowledgedEntryId: pending.baselineAcknowledgedEntryId } : undefined; }
}
