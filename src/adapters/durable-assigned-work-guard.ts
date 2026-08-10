import { BeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter";
import type { AssignedWorkGuard } from "../team-authority/assigned-work-guard";

/** Durable Task-authority query used only to guard Team carrier transitions. */
export class DurableAssignedWorkGuard implements AssignedWorkGuard {
  async nonterminalTaskIds(teamName: string, workerName?: string): Promise<string[]> {
    const tasksForGuard = await new BeadsTaskAdapter(teamName, "team-lead").list();
    return tasksForGuard
      .filter((task) => (!workerName || task.assignee === workerName) && task.status !== "closed")
      .map((task) => task.id);
  }
}
