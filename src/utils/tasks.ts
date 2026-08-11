// Project: pi-teams
//
// Semantic Task facade. Native Beads records, metadata, revisions, and
// mutation syntax remain inside the Beads adapter modules.
import type { TaskCard } from "../task-authority/task-domain";
import type { BeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";

export async function readTask(teamName: string, taskId: string, factory: BeadsTaskAdapterFactory): Promise<TaskCard> {
  const result = await factory(teamName, "team-lead").read(taskId);
  if (result.kind === "contract_gap") throw new Error(result.message);
  return result.task;
}

export async function readTasks(teamName: string, taskIds: readonly string[], factory: BeadsTaskAdapterFactory): Promise<TaskCard[]> {
  const results = await factory(teamName, "team-lead").readMany(taskIds);
  return results.flatMap((result) => result && result.kind === "found" ? [result.task] : []);
}

export async function listTasks(teamName: string, factory: BeadsTaskAdapterFactory): Promise<TaskCard[]> {
  return factory(teamName, "team-lead").list();
}

export async function listTasksWithVersions(
  teamName: string,
  filter: { assignee?: string; nonterminalOnly?: boolean } = {},
  factory: BeadsTaskAdapterFactory,
): Promise<TaskCard[]> {
  const tasks = await listTasks(teamName, factory);
  return tasks.filter((task) =>
    (filter.assignee === undefined || task.assignee === filter.assignee)
    && (!filter.nonterminalOnly || task.status !== "closed"));
}
