import type { AlertSender } from "../alert-authority/contracts";
import type { WorkerLaunchBridge } from "../team-authority/worker-launch-bridge";
import type { BeadsTaskAdapterFactory } from "./beads-task-adapter";
import { resolveTeamTaskAuthority } from "./beads-authority-adapter";
import { CoordinationObservationService } from "../coordination/observation-service";
import { DurableModelToolBindings } from "./durable-model-tool-bindings";
import { DurableModelToolTeamApplication, type ModelToolLifecycle } from "./durable-model-tool-team-application";
import { DurableModelToolTaskApplication } from "./durable-model-tool-task-application";
import { DurableModelToolAlertApplication } from "./durable-model-tool-alert-application";
import { DurableModelToolCoordinationApplication } from "./durable-model-tool-coordination-application";
import { exactLeaderSessionId } from "./model-tool-contracts";
import type { ExactLeaderSessionId, ModelToolTeamPort } from "./model-tool-contracts";
import type { ModelToolJourneyPort } from "./model-tool-journey-port";

export { DurableModelToolBindings } from "./durable-model-tool-bindings";
export { DurableModelToolTeamApplication, type ModelToolLifecycle } from "./durable-model-tool-team-application";
export { DurableModelToolTaskApplication } from "./durable-model-tool-task-application";
export { DurableModelToolAlertApplication } from "./durable-model-tool-alert-application";
export { DurableModelToolCoordinationApplication } from "./durable-model-tool-coordination-application";

/**
 * Flat compatibility adapter for existing direct callers. New composition uses
 * the four exported application classes directly; this class owns no state.
 */
export class DurableModelToolTeamPort implements ModelToolTeamPort, ModelToolJourneyPort {
  readonly team: DurableModelToolTeamApplication;
  readonly task: DurableModelToolTaskApplication;
  readonly alert: DurableModelToolAlertApplication;
  readonly coordination: DurableModelToolCoordinationApplication;

  constructor(
    launchBridge: WorkerLaunchBridge | undefined,
    lifecycle: ModelToolLifecycle | undefined,
    taskAdapterFactory: BeadsTaskAdapterFactory,
    alertSender: AlertSender | undefined,
    observationService: CoordinationObservationService,
  ) {
    const bindings = new DurableModelToolBindings();
    this.team = new DurableModelToolTeamApplication(bindings, launchBridge, lifecycle, { resolve: resolveTeamTaskAuthority });
    this.task = new DurableModelToolTaskApplication(bindings, taskAdapterFactory);
    this.alert = new DurableModelToolAlertApplication(bindings, alertSender);
    this.coordination = new DurableModelToolCoordinationApplication(bindings, observationService);
  }

  createTeam(...args: Parameters<DurableModelToolTeamApplication["createTeam"]>) { return this.team.createTeam(...args); }
  ensureWorker(...args: Parameters<DurableModelToolTeamApplication["ensureWorker"]>) { return this.team.ensureWorker(...args); }
  stopWorker(...args: Parameters<DurableModelToolTeamApplication["stopWorker"]>) { return this.team.stopWorker(...args); }
  shutdownTeam(...args: Parameters<DurableModelToolTeamApplication["shutdownTeam"]>) { return this.team.shutdownTeam(...args); }
  setLeaderSessionFile(...args: Parameters<NonNullable<DurableModelToolTeamApplication["setLeaderSessionFile"]>>) { return this.team.setLeaderSessionFile(...args); }
  setLeaderLaunchContext(...args: Parameters<NonNullable<DurableModelToolTeamApplication["setLeaderLaunchContext"]>>) { return this.team.setLeaderLaunchContext(...args); }
  createTask(...args: Parameters<DurableModelToolTaskApplication["createTask"]>) { return this.task.createTask(...args); }
  readTasks(...args: Parameters<DurableModelToolTaskApplication["readTasks"]>) { return this.task.readTasks(...args); }
  updateTasks(...args: Parameters<DurableModelToolTaskApplication["updateTasks"]>) { return this.task.updateTasks(...args); }
  linkTask(...args: Parameters<DurableModelToolTaskApplication["linkTask"]>) { return this.task.linkTask(...args); }
  sendAlert(...args: Parameters<DurableModelToolAlertApplication["sendAlert"]>) { return this.alert.sendAlert(...args); }
  readSnapshot(...args: Parameters<DurableModelToolCoordinationApplication["readSnapshot"]>) { return this.coordination.readSnapshot(...args); }
  readTeamSync(...args: Parameters<DurableModelToolCoordinationApplication["readTeamSync"]>) { return this.coordination.readTeamSync(...args); }
  readSyncNudgeDebt(...args: Parameters<DurableModelToolCoordinationApplication["readSyncNudgeDebt"]>) { return this.coordination.readSyncNudgeDebt(...args); }
  setPendingObservationResult(...args: Parameters<DurableModelToolCoordinationApplication["setPendingObservationResult"]>) { return this.coordination.setPendingObservationResult(...args); }
  acknowledgePendingObservation(...args: Parameters<DurableModelToolCoordinationApplication["acknowledgePendingObservation"]>) { return this.coordination.acknowledgePendingObservation(...args); }
  acknowledgePendingObservationAsync(...args: Parameters<DurableModelToolCoordinationApplication["acknowledgePendingObservationAsync"]>) { return this.coordination.acknowledgePendingObservationAsync(...args); }
  setBranchContext(...args: Parameters<DurableModelToolCoordinationApplication["setBranchContext"]>) { return this.coordination.setBranchContext(...args); }
  getPendingObservation(...args: Parameters<DurableModelToolCoordinationApplication["getPendingObservation"]>) { return this.coordination.getPendingObservation(...args); }
}

export function durableModelToolLeaderSessionId(value: string): ExactLeaderSessionId { return exactLeaderSessionId(value); }
