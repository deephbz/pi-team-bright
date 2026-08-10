import type { ModelToolJourneyPort } from "./model-tool-journey-port";

/** Named authority ports for one model-tool journey. */
export interface ModelToolJourneyPorts extends ModelToolJourneyPort {}

/**
 * Stateless Trio composition. It holds four independent application ports and
 * deliberately provides neither authority state nor a cross-authority action.
 */
export class ModelToolJourneyFacade implements ModelToolJourneyPort {
  constructor(
    readonly team: ModelToolJourneyPort["team"],
    readonly task: ModelToolJourneyPort["task"],
    readonly alert: ModelToolJourneyPort["alert"],
    readonly coordination: ModelToolJourneyPort["coordination"],
  ) {}
}

export function modelToolJourney(ports: ModelToolJourneyPorts): ModelToolJourneyPort {
  return new ModelToolJourneyFacade(ports.team, ports.task, ports.alert, ports.coordination);
}
