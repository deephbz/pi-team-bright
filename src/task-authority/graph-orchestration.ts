import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import type {
  TaskMutationCoordinates,
  TaskMutationPublicationPort,
} from "../model-tool-contract/beads-authority-adapter";
import { readConfig } from "../utils/teams";
import {
  GraphControlRefusal,
  type GraphApplyInput,
  type GraphTaskTransitionInput,
  type GraphTaskTransition,
  type GraphVersionRef,
} from "./graph-control";
import type { GraphTaskCard } from "./graph-control-schemas";
import type { TaskVersionRef } from "./task-version-ref";
import type { TaskReadyDeliveryPort } from "./ready-dispatch";
import type { GraphRevisionRetirementPort } from "./graph-revision-retirement";

export type GraphApplyOrchestrationOutcome =
  | {
    kind: "applied";
    operationId: string;
    replayed: boolean;
    graphVersion: GraphVersionRef;
    tasks: GraphTaskCard[];
    readyTaskIds: string[];
    deliveryWarnings: string[];
  }
  | {
    kind: "refused";
    operationId: string;
    reason: "worker_unavailable" | "invalid_graph" | "graph_version_conflict" | "operation_conflict";
    message: string;
  }
  | { kind: "unknown_outcome"; operationId: string; message: string }
  | { kind: "unavailable"; operationId: string; reason: "task_authority_unavailable"; message: string };

export type GraphTransitionOrchestrationOutcome =
  | {
    kind: "updated";
    operationId: string;
    replayed: boolean;
    transition: GraphTaskTransition | "context_updated";
    task: GraphTaskCard;
    readyTaskIds: string[];
    failureTraversal?: { sourceTaskId: string; targetTaskId: string; traversal: number };
    deliveryWarnings: string[];
  }
  | {
    kind: "refused";
    operationId: string;
    taskId: string;
    reason:
      | "task_not_found"
      | "version_conflict"
      | "operation_conflict"
      | "invalid_transition"
      | "worker_mismatch"
      | "worker_occupied"
      | "evidence_required"
      | "model_alias_unresolved";
    message: string;
    currentTask?: GraphTaskCard;
  }
  | { kind: "unknown_outcome"; operationId: string; taskId: string; message: string }
  | { kind: "unavailable"; operationId: string; taskId: string; reason: "task_authority_unavailable"; message: string };

export interface GraphTaskOrchestrationPort {
  applyGraph(teamName: string, input: GraphApplyInput): Promise<GraphApplyOrchestrationOutcome>;
  transition(teamName: string, input: GraphTaskTransitionInput, actor: string): Promise<GraphTransitionOrchestrationOutcome>;
  readTasks(teamName: string, taskIds?: readonly string[]): Promise<GraphTaskCard[]>;
  hasGraph(teamName: string): boolean;
  reconcileReady(teamName: string, worker?: string): Promise<string[]>;
}

function graphTaskCoordinates(tasks: readonly GraphTaskCard[]) {
  return tasks.map((task) => ({
    taskId: task.id,
    taskVersion: task.version as TaskVersionRef,
  }));
}

function supersededTaskCoordinates(before: readonly GraphTaskCard[], after: readonly GraphTaskCard[]) {
  const current = new Set(graphTaskCoordinates(after).map((task) => `${task.taskId}\u0000${task.taskVersion}`));
  return graphTaskCoordinates(before)
    .filter((task) => !current.has(`${task.taskId}\u0000${task.taskVersion}`));
}

function coordinates(task: GraphTaskCard): TaskMutationCoordinates {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assignee: task.assignee,
    version: task.version as TaskVersionRef,
  };
}

function refusalReason(error: GraphControlRefusal): Extract<GraphTransitionOrchestrationOutcome, { kind: "refused" }>["reason"] {
  if (error.code === "task_version_conflict") return "version_conflict";
  if (error.code === "operation_conflict") return "operation_conflict";
  if (error.code === "task_not_found") return "task_not_found";
  if (error.code === "invalid_transition") return "invalid_transition";
  if (error.code === "worker_mismatch") return "worker_mismatch";
  if (error.code === "worker_occupied") return "worker_occupied";
  if (error.code === "evidence_required") return "evidence_required";
  return "model_alias_unresolved";
}

function changeEvidence(input: GraphTaskTransitionInput, task: GraphTaskCard): { kind: "status" | "result" | "blocker" | "decision" | "note"; text: string } {
  if (input.transition === "goal_achieved" || input.transition === "goal_failed") {
    return { kind: "result", text: input.evidence ?? `Task outcome is ${input.transition}.` };
  }
  if (input.transition === "block") return { kind: "blocker", text: input.evidence ?? task.current_context };
  if (input.transition === "cancel") return { kind: "decision", text: input.evidence ?? "Task cancelled." };
  if (!input.transition) return { kind: "note", text: input.evidence ?? input.currentContext ?? "Task context changed." };
  return { kind: "status", text: `Task transition ${input.transition} produced ${task.status}.` };
}

/**
 * Graph-native Task application service.
 *
 * Authority commits and replay receipts happen before Coordination publication
 * and ready-front delivery. Publication failures remain explicit warnings and
 * are recoverable from the durable graph snapshot.
 */
export class DurableGraphTaskOrchestration implements GraphTaskOrchestrationPort {
  constructor(
    private readonly authority: DurableGraphTaskAuthority,
    private readonly publication: TaskMutationPublicationPort,
    private readonly delivery: TaskReadyDeliveryPort,
    private readonly retirement: GraphRevisionRetirementPort,
  ) {}

  hasGraph(teamName: string): boolean {
    return this.authority.exists(teamName);
  }

  readTasks(teamName: string, taskIds?: readonly string[]): Promise<GraphTaskCard[]> {
    return this.authority.readTasks(teamName, taskIds);
  }

  async applyGraph(teamName: string, input: GraphApplyInput): Promise<GraphApplyOrchestrationOutcome> {
    try {
      const config = await readConfig(teamName);
      const workers = new Set((config.logicalWorkers ?? []).map((worker) => worker.name));
      const missing = [...new Set(input.tasks.map((task) => task.assignee).filter((worker) => !workers.has(worker)))];
      if (missing.length) {
        return {
          kind: "refused",
          operationId: input.operationId,
          reason: "worker_unavailable",
          message: `Assigned Workers are not current in Team ${teamName}: ${missing.join(", ")}.`,
        };
      }
      const mutation = await this.authority.applyGraph(teamName, input);
      const warnings: string[] = [];
      const currentTasks = graphTaskCoordinates(mutation.after);
      const retiredTasks = supersededTaskCoordinates(mutation.before, mutation.after);
      try {
        await this.retirement.retireGraphRevision({
          teamName,
          graphVersion: mutation.result.graphVersion,
          graphSequence: mutation.graphSequence,
          authoritySequence: mutation.authoritySequence,
          operationId: mutation.result.operationId,
          currentTasks,
          retiredTasks,
        });
      } catch (error) {
        warnings.push(`Task graph committed but graph-revision retirement failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!mutation.result.replayed) {
        const before = new Map(mutation.before.map((task) => [task.id, task]));
        for (const task of mutation.after) {
          const prior = before.get(task.id);
          if (prior && JSON.stringify(prior) === JSON.stringify(task)) continue;
          try {
            const publication = await this.publication.publishTaskMutation({
              teamName,
              before: coordinates(prior ?? task),
              after: coordinates(task),
              created: !prior,
              kind: prior ? "task_changed" : "assigned",
              actor: "team-lead",
              taskEventEvidence: [{
                kind: prior ? "goal" : "created",
                text: `${prior ? "Task graph definition changed in" : "Task created by"} graph revision ${mutation.result.graphVersion}.`,
              }],
              deliver: false,
              taskCard: task,
            });
            warnings.push(...publication.warnings);
          } catch (error) {
            warnings.push(`Task ${task.id} committed but graph publication failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      warnings.push(...await this.reconcileReady(teamName).catch((error) => [
        `Task graph committed but ready-delivery reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      ]));
      return {
        kind: "applied",
        operationId: mutation.result.operationId,
        replayed: mutation.result.replayed,
        graphVersion: mutation.result.graphVersion,
        tasks: mutation.after,
        readyTaskIds: mutation.result.readyTaskIds,
        deliveryWarnings: [...new Set(warnings)].sort(),
      };
    } catch (error) {
      if (error instanceof GraphControlRefusal) {
        return {
          kind: "refused",
          operationId: input.operationId,
          reason: error.code === "graph_version_conflict" ? "graph_version_conflict"
            : error.code === "operation_conflict" ? "operation_conflict"
              : "invalid_graph",
          message: error.message,
        };
      }
      return {
        kind: "unknown_outcome",
        operationId: input.operationId,
        message: `Graph apply outcome is unknown after durable authority interaction: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async transition(teamName: string, input: GraphTaskTransitionInput, actor: string): Promise<GraphTransitionOrchestrationOutcome> {
    try {
      const mutation = await this.authority.transition(teamName, input);
      const warnings: string[] = [];
      if (!mutation.result.replayed) {
        const before = new Map(mutation.before.map((task) => [task.id, task]));
        for (const task of mutation.after) {
          const prior = before.get(task.id);
          if (!prior || JSON.stringify(prior) === JSON.stringify(task)) continue;
          const direct = task.id === input.taskId;
          try {
            const publication = await this.publication.publishTaskMutation({
              teamName,
              before: coordinates(prior),
              after: coordinates(task),
              created: false,
              kind: prior.status === task.status ? "note_appended" : "status_changed",
              actor,
              taskEventEvidence: [direct
                ? changeEvidence(input, task)
                : { kind: "status", text: `Graph control derived ${task.status} after operation ${input.operationId}.` }],
              deliver: false,
              taskCard: task,
            });
            warnings.push(...publication.warnings);
          } catch (error) {
            warnings.push(`Task ${task.id} committed but transition publication failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      try {
        await this.retirement.retireGraphRevision({
          teamName,
          graphVersion: mutation.graphVersion,
          graphSequence: mutation.graphSequence,
          authoritySequence: mutation.authoritySequence,
          operationId: mutation.result.operationId,
          currentTasks: graphTaskCoordinates(mutation.after),
          retiredTasks: supersededTaskCoordinates(mutation.before, mutation.after),
        });
      } catch (error) {
        warnings.push(`Task transition committed but graph-revision retirement failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      warnings.push(...await this.reconcileReady(teamName).catch((error) => [
        `Task transition committed but ready-delivery reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      ]));
      const task = mutation.after.find((candidate) => candidate.id === input.taskId);
      if (!task) throw new Error(`Committed graph transition omitted Task ${input.taskId}.`);
      return {
        kind: "updated",
        operationId: mutation.result.operationId,
        replayed: mutation.result.replayed,
        transition: mutation.result.transition,
        task,
        readyTaskIds: mutation.result.readyTaskIds,
        ...(mutation.result.failureTraversal ? { failureTraversal: mutation.result.failureTraversal } : {}),
        deliveryWarnings: [...new Set(warnings)].sort(),
      };
    } catch (error) {
      if (error instanceof GraphControlRefusal) {
        let currentTask: GraphTaskCard | undefined;
        try { currentTask = await this.authority.readTask(teamName, input.taskId); } catch {}
        return {
          kind: "refused",
          operationId: input.operationId,
          taskId: input.taskId,
          reason: refusalReason(error),
          message: error.message,
          ...(currentTask ? { currentTask } : {}),
        };
      }
      return {
        kind: "unknown_outcome",
        operationId: input.operationId,
        taskId: input.taskId,
        message: `Task transition outcome is unknown after durable authority interaction: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async reconcileReady(teamName: string, worker?: string): Promise<string[]> {
    if (!this.hasGraph(teamName)) return [];
    const frontier = await this.authority.readyFrontier(teamName, worker);
    const warnings: string[] = [];
    for (const task of frontier) {
      try {
        const coordinates = await this.delivery.readDeliveryCoordinates(teamName, task.assignee);
        const alreadyQueued = coordinates.some((coordinate) =>
          coordinate.taskId === task.id && coordinate.taskVersion === task.version);
        if (alreadyQueued) continue;
        const queued = await this.delivery.enqueueReadyTask(teamName, task, task.assignee);
        if (!queued) warnings.push(`Ready Task ${task.id} has no exact current Session for Worker ${task.assignee}.`);
      } catch (error) {
        warnings.push(`Ready Task ${task.id} delivery failed for ${task.assignee}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return warnings.sort();
  }
}
