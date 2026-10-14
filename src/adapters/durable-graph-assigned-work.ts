import type { GraphTaskOrchestrationPort } from "../task-authority/graph-orchestration";
import { isTaskTerminal } from "../task-authority/task-domain";
import type { AssignedWorkGuard } from "../team-authority/assigned-work-guard";

/** Team lifecycle guard over graph-native derived terminal state. */
export class DurableGraphAssignedWorkGuard implements AssignedWorkGuard {
  constructor(private readonly graph: GraphTaskOrchestrationPort) {}

  async nonterminalTaskIds(teamName: string): Promise<string[]> {
    return (await this.graph.readTasks(teamName)).filter((task) => !isTaskTerminal(task)).map((task) => task.id);
  }

  async nonterminalTaskIdsAssignedToWorker(teamName: string, workerName: string): Promise<string[]> {
    return (await this.graph.readTasks(teamName))
      .filter((task) => task.assignee === workerName && !isTaskTerminal(task))
      .map((task) => task.id);
  }
}
