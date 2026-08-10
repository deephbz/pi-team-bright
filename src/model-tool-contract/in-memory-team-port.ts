import type { TaskVersionRef } from "../task-authority/task-version-ref";
import type { TeamPaneLayout } from "../utils/team-pane-layout";
import type {
  AlertSendPortResult,
  AlertTarget,
  CreateTaskPortResult,
  CreateTeamPortResult,
  EnsureWorkerPortResult,
  ExactLeaderSessionId,
  ModelToolLeaderLaunchContext,
  ModelToolTaskJournalEntry,
  ModelToolTaskUpdateInput,
  ModelToolTeamCurrent,
  ModelToolTeamEvent,
  ModelToolWorkerCurrent,
  PendingObservation,
  ReadTaskContractGap,
  ReadTasksPortResult,
  TaskLinkPortInput,
  TaskLinkPortResult,
  TaskUpdatePortOutcome,
  TeamShutdownPortResult,
  TeamSnapshotPortResult,
  TeamSyncPortResult,
  UpdateTasksPortResult,
  WorkerStopPortResult,
  ModelToolTeamPort as LegacyModelToolTeamPort,
} from "./model-tool-contracts";
export { exactLeaderSessionId } from "./model-tool-contracts";
export type {
  AlertSendPortResult,
  AlertTarget,
  CreateTaskPortResult,
  CreateTeamPortResult,
  EnsureWorkerPortResult,
  ExactLeaderSessionId,
  ModelToolLeaderLaunchContext,
  ModelToolTaskJournalEntry,
  ModelToolTaskUpdateInput,
  ModelToolTeamCurrent,
  ModelToolTeamEvent,
  ModelToolWorkerCurrent,
  PendingObservation,
  ReadTaskContractGap,
  ReadTasksPortResult,
  TaskLinkPortInput,
  TaskLinkPortResult,
  TaskUpdatePortOutcome,
  TeamShutdownPortResult,
  TeamSnapshotPortResult,
  TeamSyncPortResult,
  UpdateTasksPortResult,
  WorkerStopPortResult,
} from "./model-tool-contracts";

export type { ModelToolTeamPort } from "./model-tool-contracts";

export interface InMemoryModelToolTeamDebugState { revision: number; bindings: Array<{ leaderSessionId: string; teamId: string; teamName: string }>; teams: Array<{ id: string; name: string; purpose: string; lifecycle: "active"; leaderSessionId: string; workers: ModelToolWorkerCurrent[] }>; }

import { createInMemoryModelToolJourney } from "./in-memory-model-tool-journey";

/**
 * Legacy flat adapter. It owns no state and keeps the old default behavior.
 * Tests that need authority behavior use createInMemoryModelToolJourney().
 */
export class InMemoryModelToolTeamPort implements LegacyModelToolTeamPort {
  private readonly fixture = createInMemoryModelToolJourney();
  private get ports() { return this.fixture.ports; }
  createTeam(...args: Parameters<LegacyModelToolTeamPort["createTeam"]>) { return this.ports.team.createTeam(...args); }
  ensureWorker(...args: Parameters<LegacyModelToolTeamPort["ensureWorker"]>) { return this.ports.team.ensureWorker(...args); }
  readSnapshot(...args: Parameters<LegacyModelToolTeamPort["readSnapshot"]>) { return this.ports.coordination.readSnapshot(...args); }
  createTask(...args: Parameters<LegacyModelToolTeamPort["createTask"]>) { return this.ports.task.createTask(...args); }
  readTasks(...args: Parameters<LegacyModelToolTeamPort["readTasks"]>) { return this.ports.task.readTasks(...args); }
  updateTasks(...args: Parameters<LegacyModelToolTeamPort["updateTasks"]>) { return this.ports.task.updateTasks(...args); }
  stopWorker(...args: Parameters<LegacyModelToolTeamPort["stopWorker"]>) { return this.ports.team.stopWorker(...args); }
  shutdownTeam(...args: Parameters<LegacyModelToolTeamPort["shutdownTeam"]>) { return this.ports.team.shutdownTeam(...args); }
  linkTask(...args: Parameters<LegacyModelToolTeamPort["linkTask"]>) { return this.ports.task.linkTask(...args); }
  sendAlert(...args: Parameters<LegacyModelToolTeamPort["sendAlert"]>) { return this.ports.alert.sendAlert(...args); }
  readTeamSync(...args: Parameters<LegacyModelToolTeamPort["readTeamSync"]>) { return this.ports.coordination.readTeamSync(...args); }
  setPendingObservationResult(...args: Parameters<LegacyModelToolTeamPort["setPendingObservationResult"]>) { return this.ports.coordination.setPendingObservationResult(...args); }
  acknowledgePendingObservation(...args: Parameters<LegacyModelToolTeamPort["acknowledgePendingObservation"]>) { return this.ports.coordination.acknowledgePendingObservation(...args); }
  setBranchContext(...args: Parameters<LegacyModelToolTeamPort["setBranchContext"]>) { return this.ports.coordination.setBranchContext(...args); }
  setLeaderSessionFile(..._args: Parameters<NonNullable<LegacyModelToolTeamPort["setLeaderSessionFile"]>>) { /* In-memory fake has no durable Session file. */ }
  setLeaderLaunchContext(..._args: Parameters<NonNullable<LegacyModelToolTeamPort["setLeaderLaunchContext"]>>) { /* In-memory fake has no Worker launch boundary. */ }
  acknowledgePendingObservationAsync(...args: Parameters<NonNullable<LegacyModelToolTeamPort["acknowledgePendingObservationAsync"]>>) { return Promise.resolve(this.ports.coordination.acknowledgePendingObservation(...args)); }
  readSyncNudgeDebt(..._args: Parameters<NonNullable<LegacyModelToolTeamPort["readSyncNudgeDebt"]>>) { return Promise.resolve({ kind: "none" } as import("../utils/sync-nudge-conductor").SyncNudgeDebt); }
  getPendingObservation(...args: [ExactLeaderSessionId]) { return this.ports.coordination.getPendingObservation(...args); }
  readDebugRevision() { return this.fixture.debug.readRevision(); }
  readDebugState(): InMemoryModelToolTeamDebugState { return this.fixture.debug.readState(); }
}
