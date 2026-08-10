import * as tasks from "../utils/tasks";
import type { AssignedWorkGuard } from "../team-authority/assigned-work-guard";

/** Durable Task-authority query used only to guard Team carrier transitions. */
export class DurableAssignedWorkGuard implements AssignedWorkGuard {
  async nonterminalTaskIds(teamName: string, workerName?: string): Promise<string[]> {
    const tasksForGuard = await tasks.listTasksWithVersions(teamName, {
      ...(workerName ? { assignee: workerName } : {}),
      nonterminalOnly: true,
    });
    return tasksForGuard.map((task) => task.id);
  }
}
