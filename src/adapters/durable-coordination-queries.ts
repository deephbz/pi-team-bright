import type { CoordinationQueryBundle } from "../coordination/queries";
import { DurableCoordinationAlertActuationQuery } from "./durable-coordination-alert-actuation";
import { DurableCoordinationTaskStateDeliveryQuery } from "./durable-coordination-task-state-delivery";
import { DurableCoordinationTeamRuntimeQuery } from "./durable-coordination-team-runtime";

/** One durable query bundle for Coordination composition. */
export function createDurableCoordinationQueries(): CoordinationQueryBundle {
  return {
    teamRuntime: new DurableCoordinationTeamRuntimeQuery(),
    taskStateDelivery: new DurableCoordinationTaskStateDeliveryQuery(),
    alertActuation: new DurableCoordinationAlertActuationQuery(),
  };
}
