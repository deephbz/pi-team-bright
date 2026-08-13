import { createHash } from "node:crypto";
import {
  TaskGraphValidationError,
  activeBlockerIds,
  selectDispatchFrontier,
  taskGraphFingerprint,
  validateTaskGraph,
  type DeliveryCoordinate,
  type GraphTaskState,
  type TaskGraphCreateInput,
  type TaskStatus,
} from "./dag";

export interface GraphCreateReceipt {
  operation_id: string;
  replayed: boolean;
  tasks_by_key: Record<string, GraphTaskState>;
  delivery_warnings: string[];
}

export interface PresentationPort {
  present(input: { worker: string; task: GraphTaskState; delivery_id: string }): Promise<void>;
}

export interface MechanicalDispatchSnapshot {
  schema: "pi-team-bright-mechanical-dispatch/1";
  next_task_number: number;
  tasks: GraphTaskState[];
  receipts: Array<{ operation_id: string; fingerprint: string; task_ids_by_key: Record<string, string> }>;
  deliveries: Array<DeliveryCoordinate & { delivery_id: string }>;
}

export class TaskClaimRefused extends Error {
  constructor(readonly reason: "task_not_found" | "worker_mismatch" | "active_blockers" | "not_open", readonly blockerIds: string[] = []) {
    super(reason === "active_blockers"
      ? `Task has active blockers: ${blockerIds.join(", ")}.`
      : `Task claim refused: ${reason}.`);
    this.name = "TaskClaimRefused";
  }
}

function version(taskId: string, seed: string | number): string {
  return `v_${createHash("sha256").update(`${taskId}:${seed}`).digest("hex").slice(0, 16)}`;
}

function nextVersion(task: GraphTaskState): string {
  return version(task.id, task.version);
}

function cloneTask(task: GraphTaskState): GraphTaskState {
  return { ...task, blockedBy: [...task.blockedBy] };
}

/**
 * Portable Task-authority policy reference.
 *
 * It commits graph and delivery intent before actuation. Presentation is
 * at-least-once. A Worker must still claim the exact Task explicitly.
 */
export class MechanicalTaskAuthority {
  private nextTaskNumber: number;
  private readonly tasks = new Map<string, GraphTaskState>();
  private readonly receipts = new Map<string, { fingerprint: string; taskIdsByKey: Record<string, string> }>();
  private readonly deliveries = new Map<string, DeliveryCoordinate & { delivery_id: string }>();

  constructor(private readonly presentation: PresentationPort, snapshot?: MechanicalDispatchSnapshot) {
    this.nextTaskNumber = snapshot?.next_task_number ?? 1;
    for (const task of snapshot?.tasks ?? []) this.tasks.set(task.id, cloneTask(task));
    for (const receipt of snapshot?.receipts ?? []) this.receipts.set(receipt.operation_id, {
      fingerprint: receipt.fingerprint,
      taskIdsByKey: { ...receipt.task_ids_by_key },
    });
    for (const delivery of snapshot?.deliveries ?? []) this.deliveries.set(delivery.delivery_id, { ...delivery });
  }

  snapshot(): MechanicalDispatchSnapshot {
    return {
      schema: "pi-team-bright-mechanical-dispatch/1",
      next_task_number: this.nextTaskNumber,
      tasks: this.list(),
      receipts: [...this.receipts.entries()].map(([operation_id, receipt]) => ({
        operation_id,
        fingerprint: receipt.fingerprint,
        task_ids_by_key: { ...receipt.taskIdsByKey },
      })),
      deliveries: [...this.deliveries.values()].map((delivery) => ({ ...delivery })),
    };
  }

  list(): GraphTaskState[] {
    return [...this.tasks.values()].map(cloneTask).sort((left, right) => left.id.localeCompare(right.id));
  }

  read(taskId: string): GraphTaskState | undefined {
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : undefined;
  }

  deliveryState(): Array<DeliveryCoordinate & { delivery_id: string }> {
    return [...this.deliveries.values()].map((delivery) => ({ ...delivery }));
  }

  /** Validate and commit all new nodes and edges before any presentation. */
  async createGraph(input: TaskGraphCreateInput, workers: ReadonlySet<string>): Promise<GraphCreateReceipt> {
    const fingerprint = taskGraphFingerprint(input);
    const prior = this.receipts.get(input.operation_id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new TaskGraphValidationError("operation_conflict", "The operation ID was already used with different graph semantics.", [input.operation_id]);
      }
      const tasks_by_key = Object.fromEntries(Object.entries(prior.taskIdsByKey).map(([key, id]) => [key, cloneTask(this.tasks.get(id)!)]));
      await this.reconcile();
      return { operation_id: input.operation_id, replayed: true, tasks_by_key, delivery_warnings: [] };
    }

    validateTaskGraph(input, { workers });
    const taskIdsByKey: Record<string, string> = {};
    const staged: GraphTaskState[] = [];
    for (const node of input.tasks) {
      const id = `task-${this.nextTaskNumber + staged.length}`;
      taskIdsByKey[node.key] = id;
      staged.push({
        id,
        key: node.key,
        title: node.title,
        goal: node.goal,
        status: "open",
        ...(node.assignee ? { assignee: node.assignee } : {}),
        version: version(id, 1),
        blockedBy: [],
      });
    }
    for (const dependency of input.dependencies ?? []) {
      if (!("key" in dependency.task)) {
        throw new TaskGraphValidationError("missing_task", "The portable reference authority does not mutate existing Tasks during graph creation.", [dependency.task.task_id]);
      }
      const dependentKey = dependency.task.key;
      const dependent = staged.find((task) => task.key === dependentKey)!;
      dependent.blockedBy = dependency.needs.map((need) => {
        if (!("key" in need)) throw new TaskGraphValidationError("missing_task", "The portable reference authority requires imported existing Tasks before graph expansion.", [need.task_id]);
        return taskIdsByKey[need.key];
      }).sort();
    }

    // The following synchronous state swap is the authority transaction.
    for (const task of staged) this.tasks.set(task.id, task);
    this.receipts.set(input.operation_id, { fingerprint, taskIdsByKey });
    this.nextTaskNumber += staged.length;

    const warnings = await this.reconcile();
    return {
      operation_id: input.operation_id,
      replayed: false,
      tasks_by_key: Object.fromEntries(input.tasks.map((node) => [node.key, cloneTask(this.tasks.get(taskIdsByKey[node.key])!)])),
      delivery_warnings: warnings,
    };
  }

  /** Commit ready delivery intents, then actuate them without changing Task state. */
  async reconcile(): Promise<string[]> {
    const candidates = selectDispatchFrontier(this.list(), [...this.deliveries.values()]);
    for (const task of candidates) {
      const delivery_id = `${task.id}@${task.version}`;
      this.deliveries.set(delivery_id, {
        delivery_id,
        taskId: task.id,
        taskVersion: task.version,
        worker: task.assignee!,
        state: "pending",
      });
    }

    const warnings: string[] = [];
    const pending = [...this.deliveries.values()].filter((delivery) => delivery.state === "pending");
    await Promise.all(pending.map(async (delivery) => {
      const task = this.tasks.get(delivery.taskId);
      if (!task || task.version !== delivery.taskVersion) {
        this.deliveries.delete(delivery.delivery_id);
        return;
      }
      try {
        await this.presentation.present({ worker: delivery.worker, task: cloneTask(task), delivery_id: delivery.delivery_id });
        delivery.state = "presented";
      } catch (error) {
        warnings.push(`Delivery ${delivery.delivery_id} remains pending: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    return warnings.sort();
  }

  claim(taskId: string, worker: string): GraphTaskState {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskClaimRefused("task_not_found");
    if (task.assignee !== worker) throw new TaskClaimRefused("worker_mismatch");
    if (task.status !== "open") throw new TaskClaimRefused("not_open");
    const blockers = activeBlockerIds(task, this.tasks);
    if (blockers.length) throw new TaskClaimRefused("active_blockers", blockers);
    task.status = "in_progress";
    task.version = nextVersion(task);
    this.clearDeliveriesForTask(task.id);
    return cloneTask(task);
  }

  async transition(taskId: string, status: TaskStatus): Promise<GraphTaskState> {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskClaimRefused("task_not_found");
    task.status = status;
    task.version = nextVersion(task);
    this.clearDeliveriesForTask(task.id);
    await this.reconcile();
    return cloneTask(task);
  }

  private clearDeliveriesForTask(taskId: string): void {
    for (const [id, delivery] of this.deliveries) if (delivery.taskId === taskId) this.deliveries.delete(id);
  }
}
