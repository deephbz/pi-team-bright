import type { CoordinationQueryBundle } from "../coordination/queries";
import { readRecentReceivedAlerts } from "../alert-authority/alerts";
import { DurableCoordinationAlertActuationQuery } from "./durable-coordination-alert-actuation";
import { DurableGraphTaskStateDeliveryQuery } from "./durable-graph-task-read";
import type { GraphTaskOrchestrationPort } from "../task-authority/graph-orchestration";
import { DurableCoordinationTeamRuntimeQuery } from "./durable-coordination-team-runtime";

/** One durable query bundle for Coordination composition. */
export function createDurableCoordinationQueries(
  graph: GraphTaskOrchestrationPort,
): CoordinationQueryBundle {
  return {
    teamRuntime: new DurableCoordinationTeamRuntimeQuery(),
    taskStateDelivery: new DurableGraphTaskStateDeliveryQuery(graph),
    alertActuation: new DurableCoordinationAlertActuationQuery(),
    receivedAlerts: { readRecentReceivedAlerts },
  };
}
