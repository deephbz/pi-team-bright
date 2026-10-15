import type {
  CoordinationActuationEvidence,
  CoordinationTaskReadOutcome,
  CoordinationTaskStateDeliveryQuery,
} from "../coordination/queries";
import type { GraphTaskOrchestrationPort } from "../task-authority/graph-orchestration";
import { readCurrentTaskDeliveries } from "../utils/task-delivery";
import { withGraphReadView } from "../utils/graph-read-view";

/** Required graph-authority reads with derived delivery evidence. */
export class DurableGraphTaskStateDeliveryQuery implements CoordinationTaskStateDeliveryQuery {
  constructor(
    private readonly graph: GraphTaskOrchestrationPort,
  ) {}

  withReadView<T>(action: () => Promise<T>): Promise<T> { return withGraphReadView(action); }

  completeTaskSet(_teamName: string): boolean { return true; }

  async listTaskIds(teamName: string): Promise<string[]> {
    return (await this.graph.readTasks(teamName)).map((task) => task.id);
  }

  async readTasks(teamName: string, taskIds: readonly string[]): Promise<readonly CoordinationTaskReadOutcome[]> {
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
