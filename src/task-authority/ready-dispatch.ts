import type { CanonicalTaskCard, TaskCard } from "./task-domain";
import {
  selectDispatchFrontier,
  type DeliveryCoordinate,
  type GraphTaskState,
} from "./dag";

export interface TaskDispatchSnapshot {
  /** Canonical open Tasks that the Task authority reports as blocker-free. */
  readyTasks: TaskCard[];
  /** Workers that already own an in-progress Task. */
  occupiedWorkers: string[];
}

/** Task-owned narrow read boundary for mechanical ready-front reconciliation. */
export interface TaskReadyQuery {
  readDispatchSnapshot(worker?: string): Promise<TaskDispatchSnapshot>;
}

/**
 * Consumer-owned durable delivery boundary.
 *
 * Implementations expose delivery coordinates and persist presentation intent.
 * They do not select work or change Task state.
 */
export interface TaskReadyDeliveryPort {
  readDeliveryCoordinates(teamName: string, worker: string): Promise<DeliveryCoordinate[]>;
  enqueueReadyTask(teamName: string, task: CanonicalTaskCard, worker: string): Promise<boolean>;
}

/**
 * Recompute the ready frontier from Task authority and durable delivery state.
 * Persist at most one Task-version presentation for each free stable Worker.
 */
export async function reconcileReadyTaskDeliveries(
  teamName: string,
  query: TaskReadyQuery,
  deliveryPort: TaskReadyDeliveryPort,
  worker?: string,
): Promise<string[]> {
  const snapshot = await query.readDispatchSnapshot(worker);
  const cards = snapshot.readyTasks;
  const byId = new Map(cards.map((card) => [card.id, card]));
  const deliveries: DeliveryCoordinate[] = [];
  const warnings: string[] = [];

  for (const worker of [...new Set(cards.flatMap((card) => card.assignee ? [card.assignee] : []))]) {
    try {
      for (const delivery of await deliveryPort.readDeliveryCoordinates(teamName, worker)) {
        const card = byId.get(delivery.taskId);
        if (!card || card.status === "closed" || card.status === "blocked" || card.version !== delivery.taskVersion) continue;
        deliveries.push(delivery);
      }
    } catch (error) {
      warnings.push(`Worker ${worker} delivery records are unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const graphTasks: GraphTaskState[] = cards.map((card) => ({
    id: card.id,
    title: card.title,
    goal: "goal" in card ? card.goal : "Task goal is incomplete.",
    status: card.status,
    ...(card.assignee ? { assignee: card.assignee } : {}),
    version: card.version,
    // The narrow TaskReadyQuery already obtained these cards from the
    // authoritative blocker-aware ready set. Closed predecessors need not be
    // rehydrated only to prove the same fact again.
    blockedBy: [],
  }));

  for (const task of selectDispatchFrontier(graphTasks, deliveries, snapshot.occupiedWorkers)) {
    const card = byId.get(task.id)!;
    try {
      const queued = await deliveryPort.enqueueReadyTask(teamName, card, task.assignee!);
      if (!queued) warnings.push(`Ready Task ${task.id} has no exact current Session for Worker ${task.assignee}.`);
    } catch (error) {
      warnings.push(`Task ${task.id} committed but delivery enqueue for ${task.assignee} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return warnings.sort();
}
