import fs from "node:fs";
import { inboxPath } from "../utils/paths";
import type { CoordinationActuationEvidence, CoordinationAlertActuationQuery } from "../coordination/queries";

/** Durable Alert inbox adapter for Coordination actuation evidence. */
export class DurableCoordinationAlertActuationQuery implements CoordinationAlertActuationQuery {
  async readInboxEvidence(teamName: string, worker: string): Promise<CoordinationActuationEvidence> {
    const file = inboxPath(teamName, worker);
    if (!fs.existsSync(file)) return { known: true, pending: false };
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (!Array.isArray(value) || value.some((message) => !message || typeof message !== "object" || typeof (message as { read?: unknown }).read !== "boolean")) {
        return { known: false, pending: false };
      }
      return { known: true, pending: value.some((message) => !(message as { read: boolean }).read) };
    } catch {
      return { known: false, pending: false };
    }
  }
}
