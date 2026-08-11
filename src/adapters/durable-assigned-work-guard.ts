import type { BeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";
import type { AssignedWorkGuard } from "../team-authority/assigned-work-guard";

/** Durable Task-authority query used only to guard Team carrier transitions. */
export class DurableAssignedWorkGuard implements AssignedWorkGuard {
  constructor(private readonly factory: BeadsTaskAdapterFactory) {}

  async nonterminalTaskIds(teamName: string, workerName?: string): Promise<string[]> {
    const tasksForGuard = await this.factory(teamName, "team-lead").list();
    return tasksForGuard
      .filter((task) => (!workerName || task.assignee === workerName) && task.status !== "closed")
      .map((task) => task.id);
  }
}
