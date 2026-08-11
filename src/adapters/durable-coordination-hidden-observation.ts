import {
  commitHiddenObservationProjection,
  readHiddenObservationProjection,
} from "../utils/hidden-observation";
import type {
  CoordinationHiddenObservationPort,
} from "../coordination/queries";

/** Durable hidden-observation records behind Coordination's owned port. */
export class DurableCoordinationHiddenObservation implements CoordinationHiddenObservationPort {
  async read(teamName: string, coordinate: Parameters<CoordinationHiddenObservationPort["read"]>[1]) {
    return await readHiddenObservationProjection(teamName, coordinate);
  }

  async commit(teamName: string, input: Parameters<CoordinationHiddenObservationPort["commit"]>[1]) {
    return await commitHiddenObservationProjection(teamName, input);
  }
}
