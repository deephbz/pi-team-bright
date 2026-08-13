import type { BeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";
import type {
  CoordinationActuationEvidence,
  CoordinationTaskReadOutcome,
  CoordinationTaskStateDeliveryQuery,
} from "../coordination/queries";
import type { GraphTaskOrchestrationPort } from "../task-authority/graph-orchestration";
import { readCurrentTaskDeliveries } from "../utils/task-delivery";

/** Read graph authority first, with legacy Beads fallback before first apply. */
export class DurableGraphTaskStateDeliveryQuery implements CoordinationTaskStateDeliveryQuery {
  constructor(
    private readonly graph: GraphTaskOrchestrationPort,
    private readonly legacyFactory: BeadsTaskAdapterFactory,
  ) {}

  completeTaskSet(_teamName: string): boolean {
    // This adapter is composed only for graph-first reads. Before first graph
    // apply it delegates below, where the legacy list is intentionally partial.
    return this.graph.hasGraph(_teamName);
  }

  async listTaskIds(teamName: string): Promise<string[]> {
    if (this.graph.hasGraph(teamName)) return (await this.graph.readTasks(teamName)).map((task) => task.id);
    return this.legacyFactory(teamName, "team-lead").listIds();
  }

  async readTasks(teamName: string, taskIds: readonly string[]): Promise<readonly CoordinationTaskReadOutcome[]> {
    if (!this.graph.hasGraph(teamName)) return this.legacyFactory(teamName, "team-lead").readMany([...taskIds]);
    const tasks = await this.graph.readTasks(teamName, taskIds);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return taskIds.map((taskId) => {
      const task = byId.get(taskId);
      return task ? { kind: "found" as const, task } : undefined;
    });
  }

  async readDeliveryEvidence(teamName: string, worker: string): Promise<CoordinationActuationEvidence> {
    try {
      const current = await readCurrentTaskDeliveries(teamName, worker);
      return { known: true, pending: current.some((record) => !record.successfulTurnAckAt) };
    } catch {
      return { known: false, pending: false };
    }
  }
}
