import type { CoordinationQueryBundle } from "../coordination/queries";
import { DurableCoordinationAlertActuationQuery } from "./durable-coordination-alert-actuation";
import { DurableCoordinationTaskStateDeliveryQuery } from "./durable-coordination-task-state-delivery";
import type { BeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";
import { DurableCoordinationTeamRuntimeQuery } from "./durable-coordination-team-runtime";

/** One durable query bundle for Coordination composition. */
export function createDurableCoordinationQueries(factory: BeadsTaskAdapterFactory): CoordinationQueryBundle {
  return {
    teamRuntime: new DurableCoordinationTeamRuntimeQuery(),
    taskStateDelivery: new DurableCoordinationTaskStateDeliveryQuery(factory),
    alertActuation: new DurableCoordinationAlertActuationQuery(),
  };
}
