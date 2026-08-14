import type { TaskVersionRef } from "../task-authority/task-version-ref";
import type { CanonicalTaskCard, TaskCard, TaskCardWarning } from "../task-authority/task-domain";
import type { GraphTaskTransition, GraphVersionRef } from "../task-authority/graph-control";
import type { TeamPaneLayout } from "../utils/team-pane-layout";
import type { CoordinationPendingPresentation, CoordinationSnapshotResult, CoordinationSyncResult, CoordinationTeamCurrent, CoordinationWorkerCurrent } from "../coordination/observation-contracts";
import type {
  ModelToolTaskJournalEntry,
  ModelToolTaskUpdateInput,
} from "../task-authority/contracts";
export type {
  ModelToolTaskJournalEntry,
  ModelToolTaskUpdateInput,
} from "../task-authority/contracts";

declare const exactLeaderSessionIdBrand: unique symbol;

/** Exact Pi Session identity. It is not a Session file, process, pane, or agent name. */
export type ExactLeaderSessionId = string & {
  readonly [exactLeaderSessionIdBrand]: "ExactLeaderSessionId";
};

export function exactLeaderSessionId(value: string): ExactLeaderSessionId {
  if (value.length === 0) throw new Error("Exact leader Session identity must not be empty.");
  return value as ExactLeaderSessionId;
}

export type ModelToolTeamCurrent = CoordinationTeamCurrent;

export type ModelToolWorkerCurrent = CoordinationWorkerCurrent;

export type ModelToolTaskProjectionField = "title" | "goal" | "current_context";

export type CreateTeamPortResult =
  | { kind: "created"; team: ModelToolTeamCurrent }
  | { kind: "refused"; reason: "active_team_exists" | "name_unavailable" }
  | { kind: "unavailable"; reason: "team_authority_unavailable" | "session_binding_unavailable" | "task_authority_unavailable" | "carrier_unavailable"; message: string };

export type EnsureWorkerPortResult =
  | { kind: "created"; worker: ModelToolWorkerCurrent }
  | { kind: "reused"; worker: ModelToolWorkerCurrent }
  | { kind: "scope_conflict"; worker: ModelToolWorkerCurrent }
  | { kind: "unavailable"; reason: "carrier_unavailable" | "team_authority_unavailable"; message: string }
  | { kind: "no_active_team" };

/** Ephemeral execution data. It is neither tool input nor durable Team state. */
export interface EnsureWorkerExecutionContext {
  availableModelKeys?: ReadonlySet<string>;
}

export type TeamSnapshotPortResult = CoordinationSnapshotResult;

export interface ModelToolTaskGraphInput {
  operationId: string;
  expectedGraphVersion?: GraphVersionRef;
  tasks: Array<{
    key: string;
    title: string;
    goal: string;
    assignee: string;
    model?: "default" | "capable";
    needs?: string[];
    onGoalFailed?: { target: string; maxTraversals: number };
  }>;
}

export interface ModelToolGraphTaskUpdateInput {
  taskId: string;
  operationId: string;
  expectedVersion: TaskVersionRef;
  transition?: GraphTaskTransition;
  currentContext?: string;
  evidence?: string;
}

export type CreateTaskGraphPortResult =
  | { kind: "created"; operationId: string; replayed: boolean; graphVersion: GraphVersionRef; tasksByKey: Record<string, CanonicalTaskCard>; readyTaskIds: string[]; deliveryWarnings?: string[] }
  | { kind: "refused"; operationId: string; reason: "worker_unavailable" | "invalid_graph" | "graph_version_conflict" | "graph_conflict" | "version_conflict" | "operation_conflict"; message: string }
  | { kind: "unknown_outcome"; operationId: string; message: string }
  | { kind: "unavailable"; operationId: string; reason: "task_authority_unavailable"; message: string }
  | { kind: "no_active_team"; operationId: string };

/** Compatibility result for non-model one-Task callers. */
export type CreateTaskPortResult =
  | { kind: "created"; operationId: string; task: TaskCard; deliveryWarnings?: string[] }
  | { kind: "operation_conflict"; operationId: string; message: string }
  | { kind: "unknown_outcome"; operationId: string; message: string }
  | { kind: "worker_unavailable"; operationId: string }
  | { kind: "unavailable"; operationId: string; reason: "task_authority_unavailable"; message: string }
  | { kind: "no_active_team"; operationId: string };

export type ReadTaskContractGap = {
  kind: "contract_gap";
  reason: "task_metadata_absent" | "task_metadata_invalid";
  version: TaskVersionRef;
  message: string;
  projectionWarning?: TaskCardWarning;
};

export type ReadTasksPortResult =
  | { kind: "read"; tasks: Array<CanonicalTaskCard | undefined | ReadTaskContractGap> }
  | { kind: "unavailable"; reason: "task_authority_unavailable"; message: string }
  | { kind: "no_active_team" };

export type TaskUpdatePortOutcome =
  | { kind: "updated"; taskId: string; operationId: string; replayed?: boolean; task: CanonicalTaskCard; journalEntries: ModelToolTaskJournalEntry[]; transition?: GraphTaskTransition | "context_updated"; readyTaskIds?: string[]; failureTraversal?: { sourceTaskId: string; targetTaskId: string; traversal: number }; deliveryWarnings?: string[] }
  | { kind: "refused"; taskId: string; operationId: string; reason: "task_not_found" | "version_conflict" | "operation_conflict" | "active_blockers" | "invalid_transition" | "legacy_transition_unsupported" | "worker_mismatch" | "worker_occupied" | "evidence_required" | "model_alias_unresolved"; message: string; currentTask?: CanonicalTaskCard; blockerIds?: string[] }
  | { kind: "contract_gap"; taskId: string; operationId: string; reason: "task_metadata_absent" | "task_metadata_invalid" | "external_writer_atomicity_unavailable"; message: string; currentTask?: TaskCard; unsupported: string[] }
  | { kind: "unknown_outcome"; taskId: string; operationId: string; message: string }
  | { kind: "unavailable"; taskId: string; operationId: string; reason: "task_authority_unavailable"; message: string };

export type UpdateTasksPortResult =
  | { kind: "batch"; outcomes: TaskUpdatePortOutcome[] }
  | { kind: "duplicate_task_id" }
  | { kind: "no_active_team" };

export type WorkerStopPortResult =
  | { kind: "stopped"; worker: string }
  | { kind: "refused"; worker: string; reason: "worker_not_found" | "nonterminal_tasks_assigned" | "stop_not_confirmed" | "leader_reserved"; message: string; guardingTaskIds?: string[] }
  | { kind: "unavailable"; reason: "no_active_team" | "team_authority_unavailable" | "carrier_unavailable"; message: string };

export type TeamShutdownPortResult =
  | { kind: "shutdown"; stoppedWorkers: string[]; unfinishedTaskIds: string[] }
  | { kind: "partial"; stoppedWorkers: string[]; failedWorkers: string[]; unfinishedTaskIds: string[] }
  | { kind: "unavailable"; reason: "no_active_team" | "team_authority_unavailable"; message: string };

export interface TaskLinkPortInput {
  taskId: string;
  relation: "blocked_by" | "parent" | "related";
  targetId: string;
  action: "add" | "remove";
  expectedVersion?: TaskVersionRef;
}

export type TaskLinkPortResult =
  | { kind: "linked"; taskId: string; targetId: string; relation: TaskLinkPortInput["relation"]; action: TaskLinkPortInput["action"]; changed: boolean; version: TaskVersionRef }
  | { kind: "refused"; taskId: string; reason: "task_not_found" | "version_conflict" | "graph_conflict"; message: string }
  | { kind: "unavailable"; reason: "no_active_team" | "task_authority_unavailable"; message: string };

export type AlertSendPortResult =
  | { kind: "sent"; alertId: string; acceptedRecipients: string[]; failedRecipients: string[] }
  | { kind: "refused"; reason: "recipient_not_current" | "no_eligible_recipients" | "invalid_fanout"; message: string }
  | { kind: "unavailable"; reason: "no_active_team" | "team_authority_unavailable"; message: string };

export interface ModelToolTeamEvent {
  kind: "team_created" | "worker_created" | "task_created" | "task_updated" | "alert_sent";
  taskId?: string;
  workerName?: string;
  journalEntries?: ModelToolTaskJournalEntry[];
  statusChanged?: boolean;
  relationChanged?: boolean;
}

export type TeamSyncPortResult = CoordinationSyncResult;

export type PendingObservation = CoordinationPendingPresentation;

export type AlertTarget =
  | { kind: "worker"; name: string }
  | { kind: "team" };

export interface ModelToolLeaderLaunchContext {
  /** Exact leader cwd used for Worker launch trust resolution. */
  cwd: string;
  /** Resolved Pi trust, or undefined when the ExtensionContext lacks it. */
  projectTrusted?: boolean;
}

/** Flat compatibility contract. Compatibility wrappers depend inward on this contract. */
export interface ModelToolTeamPort {
  createTeam(leaderSessionId: ExactLeaderSessionId, input: { name: string; purpose: string; pane_layout?: TeamPaneLayout }): Promise<CreateTeamPortResult>;
  ensureWorker(leaderSessionId: ExactLeaderSessionId, input: { name: string; scope: string }, context?: EnsureWorkerExecutionContext): Promise<EnsureWorkerPortResult>;
  readSnapshot(leaderSessionId: ExactLeaderSessionId): Promise<TeamSnapshotPortResult>;
  createTask(leaderSessionId: ExactLeaderSessionId, input: { operationId: string; title: string; goal: string; assignee?: string }): Promise<CreateTaskPortResult>;
  createTaskGraph(leaderSessionId: ExactLeaderSessionId, input: ModelToolTaskGraphInput): Promise<CreateTaskGraphPortResult>;
  readTasks(leaderSessionId: ExactLeaderSessionId, taskIds: string[]): Promise<ReadTasksPortResult>;
  updateTasks(leaderSessionId: ExactLeaderSessionId, updates: Array<ModelToolTaskUpdateInput | ModelToolGraphTaskUpdateInput>, actor?: string): Promise<UpdateTasksPortResult>;
  stopWorker(leaderSessionId: ExactLeaderSessionId, worker: string): Promise<WorkerStopPortResult>;
  shutdownTeam(leaderSessionId: ExactLeaderSessionId): Promise<TeamShutdownPortResult>;
  linkTask(leaderSessionId: ExactLeaderSessionId, input: TaskLinkPortInput): Promise<TaskLinkPortResult>;
  sendAlert(leaderSessionId: ExactLeaderSessionId, input: { target: AlertTarget; kind: "clarification" | "attention" | "announcement"; text: string; taskId?: string; taskVersion?: TaskVersionRef }): Promise<AlertSendPortResult>;
  readTeamSync(leaderSessionId: ExactLeaderSessionId, view: "snapshot" | "updates", signal: AbortSignal, toolCallId: string): Promise<TeamSyncPortResult>;
  setPendingObservationResult(leaderSessionId: ExactLeaderSessionId, result: unknown): void;
  acknowledgePendingObservation(leaderSessionId: ExactLeaderSessionId, entryId: string, branchIds: string[]): boolean;
  setBranchContext(leaderSessionId: ExactLeaderSessionId, branchIds: string[]): void;
  setLeaderSessionFile?(leaderSessionId: ExactLeaderSessionId, sessionFile: string): void;
  setLeaderLaunchContext?(leaderSessionId: ExactLeaderSessionId, context: ModelToolLeaderLaunchContext): void;
  acknowledgePendingObservationAsync?(leaderSessionId: ExactLeaderSessionId, entryId: string, branchIds: string[]): Promise<boolean>;
  readSyncNudgeDebt?(leaderSessionId: ExactLeaderSessionId, branchLineage: string[]): Promise<import("../utils/sync-nudge-conductor").SyncNudgeDebt>;
  getPendingObservation?(leaderSessionId: ExactLeaderSessionId): PendingObservation | undefined;
  readonly readDebugRevision?: () => number;
}
