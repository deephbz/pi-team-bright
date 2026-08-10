import fs from "node:fs";
import { listTaskIds } from "../model-tool-contract/beads-authority-adapter";
import { BeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter";
import { taskDeliveryPath } from "../utils/paths";
import type {
  CoordinationActuationEvidence,
  CoordinationTaskReadOutcome,
  CoordinationTaskStateDeliveryQuery,
} from "../coordination/queries";

/** Durable Beads Task and Task-delivery adapter for Coordination queries. */
export class DurableCoordinationTaskStateDeliveryQuery implements CoordinationTaskStateDeliveryQuery {
  async listTaskIds(teamName: string): Promise<string[]> {
    return await listTaskIds(teamName);
  }

  async readTasks(teamName: string, taskIds: readonly string[]): Promise<readonly CoordinationTaskReadOutcome[]> {
    return await new BeadsTaskAdapter(teamName, "team-lead").readMany([...taskIds]);
  }

  async readDeliveryEvidence(teamName: string, worker: string): Promise<CoordinationActuationEvidence> {
    const file = taskDeliveryPath(teamName, worker);
    if (!fs.existsSync(file)) return { known: true, pending: false };
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (!Array.isArray(value) || value.some((record) => !record || typeof record !== "object" || (
        typeof (record as { successfulTurnAckAt?: unknown }).successfulTurnAckAt !== "string"
        && (record as { successfulTurnAckAt?: unknown }).successfulTurnAckAt !== undefined
      ))) return { known: false, pending: false };
      return { known: true, pending: value.some((record) => !(record as { successfulTurnAckAt?: string }).successfulTurnAckAt) };
    } catch {
      return { known: false, pending: false };
    }
  }
}
