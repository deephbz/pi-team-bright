import type { CanonicalTaskCard } from "./task-domain";

export interface DeliveryCoordinate {
  taskId: string;
  taskVersion: string;
  worker: string;
  state: "pending" | "presented";
}

/** Delivery persists presentation intent; graph authority selects work. */
export interface TaskReadyDeliveryPort {
  readDeliveryCoordinates(teamName: string, worker: string): Promise<DeliveryCoordinate[]>;
  enqueueReadyTask(teamName: string, task: CanonicalTaskCard, worker: string): Promise<boolean>;
}
