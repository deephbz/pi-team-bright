import type { TaskCard } from "./task-domain";
import type { TaskGraphCreateInput } from "./dag";

export type TaskGraphOrchestrationOutcome =
  | {
    kind: "created";
    operationId: string;
    replayed: boolean;
    tasksByKey: Record<string, TaskCard>;
    readyTaskIds: string[];
    deliveryWarnings: string[];
  }
  | {
    kind: "refused";
    operationId: string;
    reason: "worker_unavailable" | "graph_conflict" | "version_conflict" | "operation_conflict";
    message: string;
  }
  | {
    kind: "unknown_outcome";
    operationId: string;
    message: string;
  }
  | {
    kind: "unavailable";
    operationId: string;
    reason: "task_authority_unavailable";
    message: string;
  };

/** Task-owned command boundary consumed by the trio-facing model adapter. */
export interface TaskOrchestrationPort {
  createGraph(teamName: string, input: TaskGraphCreateInput): Promise<TaskGraphOrchestrationOutcome>;
  /** Reconcile all Workers, or one stable Worker during periodic recovery. */
  reconcileReady(teamName: string, worker?: string): Promise<string[]>;
}
