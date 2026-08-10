import { CoordinationObservationService } from "../coordination/observation-service";
import { createDurableCoordinationQueries } from "../adapters/durable-coordination-queries";
import { createDurableCoordinationNudgeStore } from "../adapters/durable-coordination-nudge-store";
import { projectNonterminalTaskIds, projectTaskChanges } from "./beads-task-adapter";
import type { ModelToolCoordinationApplicationPort } from "./model-tool-journey-port";
import type { ExactLeaderSessionId, PendingObservation, TeamSnapshotPortResult, TeamSyncPortResult } from "./model-tool-contracts";
import type { SyncNudgeDebt } from "../utils/sync-nudge-conductor";
import { DurableModelToolBindings } from "./durable-model-tool-bindings";
export class DurableModelToolCoordinationApplication implements ModelToolCoordinationApplicationPort {
  constructor(private readonly bindings: DurableModelToolBindings, private readonly service: CoordinationObservationService = new CoordinationObservationService(createDurableCoordinationQueries(), { projectNonterminalTaskIds, projectTaskChanges }, undefined, undefined, createDurableCoordinationNudgeStore())) {}
  async readSnapshot(id: ExactLeaderSessionId): Promise<TeamSnapshotPortResult> { const file = this.bindings.sessionFile(id); return file ? this.service.readSnapshot(file) : { kind: "no_active_team" }; }
  async readTeamSync(id: ExactLeaderSessionId, view: "snapshot" | "updates", signal: AbortSignal, call: string): Promise<TeamSyncPortResult> { const file = this.bindings.sessionFile(id); return file ? this.service.readTeamSync(file, view, signal, call) : { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." }; }
  async readSyncNudgeDebt(id: ExactLeaderSessionId, lineage: string[]): Promise<SyncNudgeDebt> { const file = this.bindings.sessionFile(id); return file ? this.service.readSyncNudgeDebt(file, lineage) : { kind: "none" }; }
  setPendingObservationResult(id: ExactLeaderSessionId, result: unknown): void { this.service.setPendingResult(this.bindings.sessionFile(id) ?? id, result); }
  acknowledgePendingObservation(_id: ExactLeaderSessionId, _entry: string, _branch: string[]): boolean { return false; }
  acknowledgePendingObservationAsync(id: ExactLeaderSessionId, entry: string, branch: string[]): Promise<boolean> { return this.service.acknowledge(this.bindings.sessionFile(id) ?? id, entry, branch); }
  setBranchContext(id: ExactLeaderSessionId, branch: string[]): void { this.service.setBranchContext(this.bindings.sessionFile(id) ?? id, branch); }
  getPendingObservation(id: ExactLeaderSessionId): PendingObservation | undefined { const pending = this.service.pending(this.bindings.sessionFile(id) ?? id); return pending ? { sessionId: pending.sessionId, toolCallId: pending.toolCallId, resultText: pending.resultText, resultDigest: pending.resultDigest, head: pending.head, epochId: pending.epochId } : undefined; }
}
