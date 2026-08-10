import type { TaskCard, TaskCardWarning } from "../task-authority/task-domain";
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

export interface CoordinationTaskReadContractGap {
  kind: "contract_gap";
  reason: "task_metadata_absent" | "task_metadata_invalid";
  taskId: string;
  version: TaskVersionRef;
  message: string;
}

export type CoordinationTaskReadOutcome =
  | { kind: "found"; task: TaskCard }
  | CoordinationTaskReadContractGap
  | undefined;

/** Team-owned carrier and exact runtime evidence. */
export interface CoordinationTeamRuntimeQuery {
  readRuntime(teamName: string, member: CoordinationMemberEvidence): Promise<CoordinationRuntimeEvidence | null>;
}

/** Task authority state plus its pending delivery evidence. */
export interface CoordinationTaskStateDeliveryQuery {
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
  tasks: TaskCard[];
  warnings: TaskCardWarning[];
}
