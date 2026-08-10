// Project: pi-teams
//
// Semantic Task facade. Native Beads records, metadata, revisions, and
// mutation syntax remain inside the Beads adapter modules.
import type { TaskCard } from "../task-authority/task-domain";
import { BeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter";
export async function readTask(teamName: string, taskId: string): Promise<TaskCard> {
  const result = await new BeadsTaskAdapter(teamName, "team-lead").read(taskId);
  if (result.kind === "contract_gap") throw new Error(result.message);
  return result.task;
}

export async function readTasks(teamName: string, taskIds: readonly string[]): Promise<TaskCard[]> {
  const results = await new BeadsTaskAdapter(teamName, "team-lead").readMany(taskIds);
  return results.flatMap((result) => result && result.kind === "found" ? [result.task] : []);
}

export async function listTasks(teamName: string): Promise<TaskCard[]> {
  return new BeadsTaskAdapter(teamName, "team-lead").list();
}

export async function listTasksWithVersions(
  teamName: string,
  filter: { assignee?: string; nonterminalOnly?: boolean } = {},
): Promise<TaskCard[]> {
  const tasks = await listTasks(teamName);
  return tasks.filter((task) =>
    (filter.assignee === undefined || task.assignee === filter.assignee)
    && (!filter.nonterminalOnly || task.status !== "closed"));
}
