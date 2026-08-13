import type { CanonicalTaskCard, TaskCardWarning } from "../task-authority/task-domain";
import type { TaskVersionRef } from "../task-authority/task-version-ref";

/** Minimum current Membership evidence used to derive Worker run state. */
export interface CoordinationMemberEvidence {
  name: string;
  membershipId?: string;
  pendingLaunchId?: string;
  sessionFile?: string;
  isActive?: boolean;
}

/** Exact runtime record fields that affect liveness. */
export interface CoordinationRuntimeGeneration {
  membershipId: string;
  pid: number;
  startedAt: number;
}

export interface CoordinationRuntimeEvidence {
  membershipId?: string;
  pid?: number;
  startedAt?: number;
  runState?: "active" | "settled";
}

export interface CoordinationActuationEvidence {
  known: boolean;
  pending: boolean;
}

/** Coordination-owned durable acknowledgement projection. */
export interface CoordinationHiddenObservationProjection {
  schema: "pi-teams-hidden-observation/1";
  teamEpochId: string;
  exactSessionId: string;
  acknowledgedEntryId: string;
  acknowledgedLineage: string[];
  teamEventCursor: string;
  authorityRevisions: Record<string, string>;
  updatedAt: string;
}

export interface CoordinationHiddenObservationCoordinate {
  teamEpochId: string;
  exactSessionId: string;
  branchLineage: string[];
}

export interface CoordinationHiddenObservationCommit extends CoordinationHiddenObservationCoordinate {
  acknowledgedEntryId: string;
  teamEventCursor: string;
  authorityRevisions?: Record<string, string>;
}

export type CoordinationHiddenObservationReadResult =
  | { kind: "found"; projection: CoordinationHiddenObservationProjection }
  | { kind: "not_found"; reason: "absent" | "lineage_mismatch" }
  | { kind: "coordinate_mismatch"; reason: "team_epoch_mismatch" | "lead_session_mismatch" }
  | { kind: "contract_gap"; reason: "team_epoch_missing" | "logical_workers_missing" | "task_metadata_absent" | "task_metadata_invalid" | "structured_task_event_evidence_absent" };

export type CoordinationHiddenObservationCommitResult =
  | { kind: "committed"; projection: CoordinationHiddenObservationProjection }
  | { kind: "refused"; reason: "team_epoch_mismatch" | "lead_session_mismatch" | "acknowledged_entry_not_in_lineage" | "stale_acknowledgement" | "acknowledgement_conflict" }
  | { kind: "contract_gap"; reason: string };

/** Read and commit acknowledgement records through Coordination's durable boundary. */
export interface CoordinationHiddenObservationPort {
  read(teamName: string, coordinate: CoordinationHiddenObservationCoordinate): Promise<CoordinationHiddenObservationReadResult>;
  commit(teamName: string, input: CoordinationHiddenObservationCommit): Promise<CoordinationHiddenObservationCommitResult>;
}

export interface CoordinationTaskReadContractGap {
  kind: "contract_gap";
  reason: "task_metadata_absent" | "task_metadata_invalid";
  taskId: string;
  version: TaskVersionRef;
  message: string;
}

export type CoordinationTaskReadOutcome =
  | { kind: "found"; task: CanonicalTaskCard }
  | CoordinationTaskReadContractGap
  | undefined;

/** Team-owned carrier and exact runtime evidence. */
export interface CoordinationLogicalWorkerEvidence {
  name: string;
  scope: string;
}

/** Exact active leader binding and logical Worker evidence for observation. */
export interface CoordinationLeaderBindingEvidence {
  teamName: string;
  epochId?: string;
  sessionFile: string;
  purpose?: string;
  syncLiveness?: { waitSeconds: number; nudgeEnabled?: boolean; nudgeDelaySeconds?: number; policyVersion?: string };
  members: Array<CoordinationMemberEvidence & { agentType?: string }>;
  logicalWorkers?: CoordinationLogicalWorkerEvidence[];
}

export interface CoordinationTeamRuntimeQuery {
  readRuntime(teamName: string, member: CoordinationMemberEvidence): Promise<CoordinationRuntimeEvidence | null>;
  readLeaderBinding?(sessionFile: string): Promise<CoordinationLeaderBindingEvidence | undefined>;
}

/** Task authority state plus its pending delivery evidence. */
export interface CoordinationTaskStateDeliveryQuery {
  /** True when listTaskIds is the complete current set, not an eventually consistent index. */
  completeTaskSet?(teamName: string): boolean;
  listTaskIds(teamName: string): Promise<string[]>;
  readTasks(teamName: string, taskIds: readonly string[]): Promise<readonly CoordinationTaskReadOutcome[]>;
  readDeliveryEvidence(teamName: string, worker: string): Promise<CoordinationActuationEvidence>;
}

/** Alert-owned inbox actuation evidence. */
export interface CoordinationAlertActuationQuery {
  readInboxEvidence(teamName: string, worker: string): Promise<CoordinationActuationEvidence>;
}

/** Explicit Coordination dependency bundle. It owns no authority records. */
export interface CoordinationQueryBundle {
  teamRuntime: CoordinationTeamRuntimeQuery;
  taskStateDelivery: CoordinationTaskStateDeliveryQuery;
  alertActuation: CoordinationAlertActuationQuery;
}

export interface CoordinationTaskProjection {
  tasks: CanonicalTaskCard[];
  warnings: TaskCardWarning[];
}
