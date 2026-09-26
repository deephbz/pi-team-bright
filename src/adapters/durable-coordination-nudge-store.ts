import type { CoordinationNudgeStore } from "../coordination/nudge-debt";
import type { CoordinationHiddenObservationPort } from "../coordination/queries";
import { DurableCoordinationHiddenObservation } from "./durable-coordination-hidden-observation";

/** Durable records used only to derive Coordination nudge debt. */
export function createDurableCoordinationNudgeStore(hidden: CoordinationHiddenObservationPort = new DurableCoordinationHiddenObservation()): CoordinationNudgeStore {
  return {
    readHidden: async (teamName, input) => {
      const result = await hidden.read(teamName, input);
      return result.kind === "found"
        ? { kind: "found" as const, projection: { teamEventCursor: result.projection.teamEventCursor, authorityRevisions: { ...result.projection.authorityRevisions } } }
        : result.kind === "contract_gap"
          ? { kind: "contract_gap" as const, reason: result.reason }
          : { kind: "missing" as const };
    },
  };
}
