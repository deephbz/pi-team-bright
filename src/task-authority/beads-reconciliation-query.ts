import type {
  TaskReconciliationQuery,
  TaskReconciliationReadOutcome,
} from "./contracts";
import type { BeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";

/** Beads implementation wired at composition for Task-delivery recovery. */
export class BeadsTaskReconciliationQuery implements TaskReconciliationQuery {
  constructor(
    private readonly teamName: string,
    private readonly factory: BeadsTaskAdapterFactory,
  ) {}

  readOwnerTransitionEvidence(taskId: string) {
    return this.factory(this.teamName, "task-delivery-reconciliation").readOwnerTransitionEvidence(taskId);
  }

  async readCurrentTasks(): Promise<TaskReconciliationReadOutcome[]> {
    const adapter = this.factory(this.teamName, "task-delivery-reconciliation");
    return adapter.readMany(await adapter.listIds());
  }
}
