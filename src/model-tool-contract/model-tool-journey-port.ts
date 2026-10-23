import type {
  AlertSendPortResult,
  CreateTaskGraphPortResult,
  ModelToolTaskGraphInput,
  ModelToolGraphTaskUpdateInput,
  CreateTeamPortResult,
  EnsureWorkerPortResult,
  EnsureWorkerExecutionContext,
  ExactLeaderSessionId,
  ModelToolLeaderLaunchContext,
  PendingObservation,
  ReadTasksPortResult,
  TeamShutdownPortResult,
  TeamSnapshotPortResult,
  TeamSyncPortResult,
  UpdateTasksPortResult,
  WorkerStopPortResult,
  AlertTarget,
} from "./model-tool-contracts";
import type { TeamPaneLayout } from "../utils/team-pane-layout";
import type { TaskVersionRef } from "../task-authority/task-version-ref";
import type { SyncNudgeDebt } from "../utils/sync-nudge-conductor";
import type { CoordinationSyncProbe, CoordinationSyncNowResult } from "../coordination/observation-contracts";

export interface ModelToolTeamApplicationPort {
  createTeam(leaderSessionId: ExactLeaderSessionId, input: { name: string; purpose: string; pane_layout?: TeamPaneLayout }): Promise<CreateTeamPortResult>;
  ensureWorker(leaderSessionId: ExactLeaderSessionId, input: { name: string; scope: string; model_role?: string }, context?: EnsureWorkerExecutionContext): Promise<EnsureWorkerPortResult>;
  stopWorker(leaderSessionId: ExactLeaderSessionId, worker: string): Promise<WorkerStopPortResult>;
  shutdownTeam(leaderSessionId: ExactLeaderSessionId): Promise<TeamShutdownPortResult>;
  setLeaderSessionFile?(leaderSessionId: ExactLeaderSessionId, sessionFile: string): void;
  setLeaderLaunchContext?(leaderSessionId: ExactLeaderSessionId, context: ModelToolLeaderLaunchContext): void;
}

export interface ModelToolTaskApplicationPort {
  createTaskGraph(leaderSessionId: ExactLeaderSessionId, input: ModelToolTaskGraphInput): Promise<CreateTaskGraphPortResult>;
  readTasks(leaderSessionId: ExactLeaderSessionId, taskIds: string[]): Promise<ReadTasksPortResult>;
  updateTasks(leaderSessionId: ExactLeaderSessionId, updates: ModelToolGraphTaskUpdateInput[], actor?: string): Promise<UpdateTasksPortResult>;
}

export interface ModelToolAlertApplicationPort {
  sendAlert(leaderSessionId: ExactLeaderSessionId, input: { target: AlertTarget; kind: "clarification" | "attention" | "announcement"; text: string; taskId?: string; taskVersion?: TaskVersionRef; interrupt?: boolean }): Promise<AlertSendPortResult>;
}

export interface ModelToolCoordinationApplicationPort {
  readSnapshot(leaderSessionId: ExactLeaderSessionId): Promise<TeamSnapshotPortResult>;
  readTeamSync(leaderSessionId: ExactLeaderSessionId, view: "snapshot" | "updates", signal: AbortSignal, toolCallId: string): Promise<TeamSyncPortResult>;
  readTeamSyncNow?(leaderSessionId: ExactLeaderSessionId, view: "snapshot" | "updates", signal: AbortSignal, toolCallId: string): Promise<CoordinationSyncNowResult>;
  peekTeamSync?(leaderSessionId: ExactLeaderSessionId, view: "snapshot" | "updates", branchLineage: string[]): Promise<CoordinationSyncProbe>;
  selectTeamSyncView?(leaderSessionId: ExactLeaderSessionId, branchLineage: string[]): Promise<"snapshot" | "updates">;
  discardPendingObservation?(leaderSessionId: ExactLeaderSessionId, toolCallId: string): void;
  setPendingObservationResult(leaderSessionId: ExactLeaderSessionId, result: unknown): void;
  setBranchContext(leaderSessionId: ExactLeaderSessionId, branchIds: string[]): void;
  setBranchEntries?(leaderSessionId: ExactLeaderSessionId, entries: import("../coordination/branch-observation").BranchEntry[]): void;
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
