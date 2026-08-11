import type { BeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";
import type { AssignedWorkGuard, NonterminalAssignedTaskQuery } from "../team-authority/assigned-work-guard";

/** Durable Task-authority query used only to guard Team carrier transitions. */
export class DurableAssignedWorkGuard implements AssignedWorkGuard {
  constructor(
    private readonly factory: BeadsTaskAdapterFactory,
    private readonly assignedTaskQuery: NonterminalAssignedTaskQuery,
  ) {}

  /** Whole-Team query remains available for shutdown reporting. */
  async nonterminalTaskIds(teamName: string): Promise<string[]> {
    const tasksForGuard = await this.factory(teamName, "team-lead").list();
    return tasksForGuard
      .filter((task) => task.status !== "closed")
      .map((task) => task.id);
  }

  /** Worker stop must not pay for, or accept a partial, full-Team projection. */
  nonterminalTaskIdsAssignedToWorker(teamName: string, workerName: string): Promise<string[]> {
    return this.assignedTaskQuery.nonterminalTaskIdsAssignedToWorker(teamName, workerName);
  }
}
