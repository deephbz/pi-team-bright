import { createDurableCoordinationQueries } from "../../src/adapters/durable-coordination-queries";
import { DurableGraphTaskAuthority } from "../../src/adapters/durable-graph-task-authority";
import { DurableTaskMutationPublication } from "../../src/adapters/durable-task-mutation-publication";
import { DurableGraphTaskOrchestration, type GraphTaskOrchestrationPort } from "../../src/task-authority/graph-orchestration";
import { CoordinationObservationService, createDurableCoordinationObservationStore } from "../../src/coordination/observation-service";
import { projectNonterminalTaskIds, projectTaskChanges } from "../../src/coordination/task-change-projection";
import { DurableModelToolTeamPort } from "../../src/model-tool-contract/durable-model-tool-port";

export function composedDurableModelToolPort(graph?: GraphTaskOrchestrationPort): DurableModelToolTeamPort {
  const publication = new DurableTaskMutationPublication();
  graph ??= new DurableGraphTaskOrchestration(new DurableGraphTaskAuthority(), publication, publication, publication);
  const queries = createDurableCoordinationQueries(graph);
  return new DurableModelToolTeamPort(undefined, undefined, graph, undefined,
    new CoordinationObservationService(queries, { projectNonterminalTaskIds, projectTaskChanges }, createDurableCoordinationObservationStore()));
}
