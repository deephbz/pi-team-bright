import type {
  TaskReconciliationQuery,
  TaskReconciliationReadOutcome,
} from "./contracts";
import { listTaskIds } from "../model-tool-contract/beads-authority-adapter";
import {
  BeadsTaskAdapter,
  readTaskOwnerTransitionEvidence,
} from "../model-tool-contract/beads-task-adapter";

/** Beads implementation wired at composition for Task-delivery recovery. */
export class BeadsTaskReconciliationQuery implements TaskReconciliationQuery {
  constructor(private readonly teamName: string) {}

  readOwnerTransitionEvidence(taskId: string) {
    return readTaskOwnerTransitionEvidence(this.teamName, taskId);
  }

  async readCurrentTasks(): Promise<TaskReconciliationReadOutcome[]> {
    return new BeadsTaskAdapter(this.teamName, "task-delivery-reconciliation")
      .readMany(await listTaskIds(this.teamName));
  }
}
