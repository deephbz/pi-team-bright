import type { CoordinationQueryBundle } from "../coordination/queries";
import { DurableCoordinationAlertActuationQuery } from "./durable-coordination-alert-actuation";
import { DurableCoordinationTaskStateDeliveryQuery } from "./durable-coordination-task-state-delivery";
import { DurableGraphTaskStateDeliveryQuery } from "./durable-graph-task-read";
import type { GraphTaskOrchestrationPort } from "../task-authority/graph-orchestration";
import type { BeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";
import { DurableCoordinationTeamRuntimeQuery } from "./durable-coordination-team-runtime";

/** One durable query bundle for Coordination composition. */
export function createDurableCoordinationQueries(
  factory: BeadsTaskAdapterFactory,
  graph?: GraphTaskOrchestrationPort,
): CoordinationQueryBundle {
  return {
    teamRuntime: new DurableCoordinationTeamRuntimeQuery(),
    taskStateDelivery: graph
      ? new DurableGraphTaskStateDeliveryQuery(graph, factory)
      : new DurableCoordinationTaskStateDeliveryQuery(factory),
    alertActuation: new DurableCoordinationAlertActuationQuery(),
  };
}
