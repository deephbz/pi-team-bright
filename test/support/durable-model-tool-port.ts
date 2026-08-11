import { createDurableCoordinationNudgeStore } from "../../src/adapters/durable-coordination-nudge-store";
import { DurableCoordinationHiddenObservation } from "../../src/adapters/durable-coordination-hidden-observation";
import { createDurableCoordinationQueries } from "../../src/adapters/durable-coordination-queries";
import { CoordinationObservationService, createDurableCoordinationObservationStore } from "../../src/coordination/observation-service";
import { createReadOnlyBeadsTaskAdapterFactory, projectNonterminalTaskIds, projectTaskChanges, type BeadsTaskAdapterFactory } from "../../src/model-tool-contract/beads-task-adapter";
import { DurableModelToolTeamPort } from "../../src/model-tool-contract/durable-model-tool-port";
import { DurableTaskAuthorityProvisioning } from "../../src/adapters/durable-task-authority-provisioning";

const emptyFactory = createReadOnlyBeadsTaskAdapterFactory({
  readTaskAuthorityRecordEnvelope: async () => undefined as any,
  readTaskAuthorityRecordEnvelopes: async () => [],
  listTaskIds: async () => [],
});

/** Builds the legacy facade with explicit Task read and Coordination dependencies. */
export function composedDurableModelToolPort(factory: BeadsTaskAdapterFactory = emptyFactory): DurableModelToolTeamPort {
  const queries = createDurableCoordinationQueries(factory);
  const hidden = new DurableCoordinationHiddenObservation();
  return new DurableModelToolTeamPort(undefined, undefined, factory, undefined,
    new CoordinationObservationService(queries, { projectNonterminalTaskIds, projectTaskChanges }, createDurableCoordinationObservationStore(hidden), undefined, createDurableCoordinationNudgeStore(hidden)),
    new DurableTaskAuthorityProvisioning());
}
