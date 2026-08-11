import { appendTeamEvent } from "../coordination/event-journal";
import type {
  AlertPublicationInput,
  AlertPublicationPort,
} from "../alert-authority/contracts";

/** Durable Coordination event adapter for accepted Alerts. */
export class DurableAlertPublication implements AlertPublicationPort {
  async appendAcceptedAlert(input: AlertPublicationInput): Promise<{ cursor: string }> {
    return await appendTeamEvent(input.teamName, {
      type: "alert",
      alertId: input.alertId,
      from: input.from,
      to: input.to,
      ...(input.taskRef ? { taskRef: input.taskRef } : {}),
      kind: input.kind,
      text: input.text,
    });
  }
}
