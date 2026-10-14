import type { ExactLeaderSessionId, ModelToolWorkerCurrent, ModelToolTeamPort as LegacyModelToolTeamPort } from "./model-tool-contracts";
export { exactLeaderSessionId } from "./model-tool-contracts";
export type * from "./model-tool-contracts";

export interface InMemoryModelToolTeamDebugState { revision: number; bindings: Array<{ leaderSessionId: string; teamId: string; teamName: string }>; teams: Array<{ id: string; name: string; purpose: string; lifecycle: "active"; leaderSessionId: string; workers: ModelToolWorkerCurrent[] }>; }

import { createInMemoryModelToolJourney } from "./in-memory-model-tool-journey";

/**
 * Flat fixture adapter. Authority fakes feed the production Coordination reader.
 * Tests that need named authorities use createInMemoryModelToolJourney().
 */
export class InMemoryModelToolTeamPort implements LegacyModelToolTeamPort {
  private readonly fixture = createInMemoryModelToolJourney();
  private get ports() { return this.fixture.ports; }
  createTeam(...args: Parameters<LegacyModelToolTeamPort["createTeam"]>) { return this.ports.team.createTeam(...args); }
  ensureWorker(...args: Parameters<LegacyModelToolTeamPort["ensureWorker"]>) { return this.ports.team.ensureWorker(...args); }
  readSnapshot(...args: Parameters<LegacyModelToolTeamPort["readSnapshot"]>) { return this.ports.coordination.readSnapshot(...args); }
  createTaskGraph(...args: Parameters<LegacyModelToolTeamPort["createTaskGraph"]>) { return this.ports.task.createTaskGraph(...args); }
  readTasks(...args: Parameters<LegacyModelToolTeamPort["readTasks"]>) { return this.ports.task.readTasks(...args); }
  updateTasks(session: ExactLeaderSessionId, updates: Parameters<LegacyModelToolTeamPort["updateTasks"]>[1], actor?: string) { return this.ports.task.updateTasks(session, updates, actor); }
  stopWorker(...args: Parameters<LegacyModelToolTeamPort["stopWorker"]>) { return this.ports.team.stopWorker(...args); }
  shutdownTeam(...args: Parameters<LegacyModelToolTeamPort["shutdownTeam"]>) { return this.ports.team.shutdownTeam(...args); }
  sendAlert(...args: Parameters<LegacyModelToolTeamPort["sendAlert"]>) { return this.ports.alert.sendAlert(...args); }
  readTeamSync(...args: Parameters<LegacyModelToolTeamPort["readTeamSync"]>) { return this.ports.coordination.readTeamSync(...args); }
  setPendingObservationResult(...args: Parameters<LegacyModelToolTeamPort["setPendingObservationResult"]>) { return this.ports.coordination.setPendingObservationResult(...args); }
  discardPendingObservation(session: ExactLeaderSessionId, toolCallId: string) { this.ports.coordination.discardPendingObservation(session, toolCallId); }
  setBranchContext(...args: Parameters<LegacyModelToolTeamPort["setBranchContext"]>) { return this.ports.coordination.setBranchContext(...args); }
  setBranchEntries(...args: Parameters<typeof this.ports.coordination.setBranchEntries>) { return this.ports.coordination.setBranchEntries(...args); }
  setLeaderSessionFile(..._args: Parameters<NonNullable<LegacyModelToolTeamPort["setLeaderSessionFile"]>>) { /* In-memory fake has no durable Session file. */ }
  setLeaderLaunchContext(..._args: Parameters<NonNullable<LegacyModelToolTeamPort["setLeaderLaunchContext"]>>) { /* In-memory fake has no Worker launch boundary. */ }
  readSyncNudgeDebt(...args: Parameters<NonNullable<LegacyModelToolTeamPort["readSyncNudgeDebt"]>>) { return this.ports.coordination.readSyncNudgeDebt(...args); }
  getPendingObservation(...args: [ExactLeaderSessionId]) { return this.ports.coordination.getPendingObservation(...args); }
  readDebugRevision() { return this.fixture.debug.readRevision(); }
  readDebugState(): InMemoryModelToolTeamDebugState { return this.fixture.debug.readState(); }
}
