import type {
  AlertSendPortResult,
  CreateTaskPortResult,
  CreateTaskGraphPortResult,
  ModelToolTaskGraphInput,
  CreateTeamPortResult,
  EnsureWorkerPortResult,
  ExactLeaderSessionId,
  ModelToolLeaderLaunchContext,
  PendingObservation,
  ReadTasksPortResult,
  TaskLinkPortInput,
  TaskLinkPortResult,
  TeamShutdownPortResult,
  TeamSnapshotPortResult,
  TeamSyncPortResult,
  UpdateTasksPortResult,
  WorkerStopPortResult,
  AlertTarget,
} from "./model-tool-contracts";
import type { TeamPaneLayout } from "../utils/team-pane-layout";
import type { ModelToolTaskUpdateInput } from "../task-authority/contracts";
import type { TaskVersionRef } from "../task-authority/task-version-ref";
import type { SyncNudgeDebt } from "../utils/sync-nudge-conductor";

export interface ModelToolTeamApplicationPort {
  createTeam(leaderSessionId: ExactLeaderSessionId, input: { name: string; purpose: string; pane_layout?: TeamPaneLayout }): Promise<CreateTeamPortResult>;
  ensureWorker(leaderSessionId: ExactLeaderSessionId, input: { name: string; scope: string }): Promise<EnsureWorkerPortResult>;
  stopWorker(leaderSessionId: ExactLeaderSessionId, worker: string): Promise<WorkerStopPortResult>;
  shutdownTeam(leaderSessionId: ExactLeaderSessionId): Promise<TeamShutdownPortResult>;
  setLeaderSessionFile?(leaderSessionId: ExactLeaderSessionId, sessionFile: string): void;
  setLeaderLaunchContext?(leaderSessionId: ExactLeaderSessionId, context: ModelToolLeaderLaunchContext): void;
}

export interface ModelToolTaskApplicationPort {
  createTask(leaderSessionId: ExactLeaderSessionId, input: { operationId: string; title: string; goal: string; assignee?: string }): Promise<CreateTaskPortResult>;
  createTaskGraph(leaderSessionId: ExactLeaderSessionId, input: ModelToolTaskGraphInput): Promise<CreateTaskGraphPortResult>;
  readTasks(leaderSessionId: ExactLeaderSessionId, taskIds: string[]): Promise<ReadTasksPortResult>;
  updateTasks(leaderSessionId: ExactLeaderSessionId, updates: ModelToolTaskUpdateInput[]): Promise<UpdateTasksPortResult>;
  linkTask(leaderSessionId: ExactLeaderSessionId, input: TaskLinkPortInput): Promise<TaskLinkPortResult>;
}

export interface ModelToolAlertApplicationPort {
  sendAlert(leaderSessionId: ExactLeaderSessionId, input: { target: AlertTarget; kind: "clarification" | "attention" | "announcement"; text: string; taskId?: string; taskVersion?: TaskVersionRef }): Promise<AlertSendPortResult>;
}

export interface ModelToolCoordinationApplicationPort {
  readSnapshot(leaderSessionId: ExactLeaderSessionId): Promise<TeamSnapshotPortResult>;
  readTeamSync(leaderSessionId: ExactLeaderSessionId, view: "snapshot" | "updates", signal: AbortSignal, toolCallId: string): Promise<TeamSyncPortResult>;
  setPendingObservationResult(leaderSessionId: ExactLeaderSessionId, result: unknown): void;
  acknowledgePendingObservation(leaderSessionId: ExactLeaderSessionId, entryId: string, branchIds: string[]): boolean;
  setBranchContext(leaderSessionId: ExactLeaderSessionId, branchIds: string[]): void;
  acknowledgePendingObservationAsync?(leaderSessionId: ExactLeaderSessionId, entryId: string, branchIds: string[]): Promise<boolean>;
  readSyncNudgeDebt?(leaderSessionId: ExactLeaderSessionId, branchLineage: string[]): Promise<SyncNudgeDebt>;
  getPendingObservation?(leaderSessionId: ExactLeaderSessionId): PendingObservation | undefined;
}

/** A Trio journey holds four authority-specific application ports. */
export interface ModelToolJourneyPort {
  readonly team: ModelToolTeamApplicationPort;
  readonly task: ModelToolTaskApplicationPort;
  readonly alert: ModelToolAlertApplicationPort;
  readonly coordination: ModelToolCoordinationApplicationPort;
}
