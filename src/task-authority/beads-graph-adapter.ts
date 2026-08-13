import {
  BeadsError,
  BeadsTaskStore,
  TASK_METADATA_KEY,
  TASK_METADATA_SCHEMA,
  beadsLabel,
  type BeadsGraphCreateInput,
  type TaskMetadata,
} from "../utils/beads";
import { projectTaskCard, type TaskProjectionGap } from "../model-tool-contract/beads-task-adapter";
import type { TaskCard } from "./task-domain";
import {
  TaskGraphValidationError,
  taskGraphFingerprint,
  validateTaskGraph,
  type ExistingTask,
  type TaskGraphCreateInput,
  type TaskRef,
} from "./dag";

const INITIAL_CONTEXT = "Work has not started.";

export type BeadsTaskGraphCreateOutcome =
  | {
    kind: "created";
    operationId: string;
    replayed: boolean;
    tasksByKey: Record<string, TaskCard>;
    readyTaskIds: string[];
    /** Existing dependent Tasks whose relation sets changed in this commit. */
    expandedTaskChanges: Array<{ before: TaskCard; after: TaskCard }>;
    /** Current existing dependents used only for missing-publication recovery. */
    expandedTasks: TaskCard[];
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
  };

function metadata(goal: string): TaskMetadata {
  return { schema: TASK_METADATA_SCHEMA, goal, current_context: INITIAL_CONTEXT };
}

function edgeRef(ref: TaskRef): { key: string } | { id: string } {
  return "key" in ref ? { key: ref.key } : { id: ref.task_id };
}

/**
 * Consumer-owned Beads adapter for atomic DAG creation.
 * It returns committed cards only. Dispatch and publication remain Task-
 * authority policy above this native syntax adapter.
 */
export class BeadsTaskGraphAdapter {
  constructor(
    readonly teamName: string,
    private readonly store: BeadsTaskStore,
    private readonly currentWorkers: () => Promise<ReadonlySet<string>>,
  ) {}

  async create(input: TaskGraphCreateInput): Promise<BeadsTaskGraphCreateOutcome> {
    try {
      const fingerprint = taskGraphFingerprint(input);
      const prior = await this.store.readGraphOperationReceipt(input.operation_id, input.tasks.map((task) => task.key));
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          return { kind: "refused", operationId: input.operation_id, reason: "operation_conflict", message: "The graph operation ID was already used with different initial semantics." };
        }
        const tasksByKey: Record<string, TaskCard> = {};
        for (const task of input.tasks) {
          const card = projectTaskCard(prior.tasksByKey[task.key]);
          if ("kind" in card) throw new Error(card.message);
          tasksByKey[task.key] = card;
        }
        const expandedIds = [...new Set((input.dependencies ?? []).flatMap((dependency) =>
          "task_id" in dependency.task ? [dependency.task.task_id] : []))];
        const expandedEnvelopes = expandedIds.length
          ? await this.store.readTaskAuthorityRecordEnvelopes(expandedIds)
          : [];
        const expandedTasks = expandedIds.map((taskId, index) => {
          const envelope = expandedEnvelopes[index];
          if (!envelope) throw new TaskGraphValidationError("missing_task", `Existing Task ${taskId} was not available during graph replay.`);
          const card = projectTaskCard(envelope);
          if ("kind" in card) throw new Error((card as TaskProjectionGap).message);
          return card;
        });
        return {
          kind: "created",
          operationId: input.operation_id,
          replayed: true,
          tasksByKey,
          readyTaskIds: Object.values(tasksByKey).filter((task) => task.status === "open" && task.dependency_state?.kind === "ready").map((task) => task.id).sort(),
          expandedTaskChanges: [],
          expandedTasks,
        };
      }
      const workers = await this.currentWorkers();
      const existingIds = [...new Set((input.dependencies ?? []).flatMap((dependency) => [
        ...( "task_id" in dependency.task ? [dependency.task.task_id] : []),
        ...dependency.needs.flatMap((need) => "task_id" in need ? [need.task_id] : []),
      ]))];
      const existingRecords = existingIds.length ? await this.store.readMany(existingIds) : [];
      const existing = new Map<string, ExistingTask>(existingRecords.map((task) => [task.id, {
        id: task.id,
        version: task.version,
        status: task.status,
      }]));

      // Public expected versions are checked below against projected cards.
      // Raw validation still proves existence, workers, shape, and cycles.
      const rawValidationInput: TaskGraphCreateInput = {
        ...input,
        dependencies: (input.dependencies ?? []).map((dependency) => ({
          ...dependency,
          task: "task_id" in dependency.task
            ? { ...dependency.task, expected_version: existing.get(dependency.task.task_id)?.version ?? dependency.task.expected_version }
            : dependency.task,
        })),
      };
      validateTaskGraph(rawValidationInput, { workers, existingTasks: existing });

      const expandedDependentIds = [...new Set((input.dependencies ?? []).flatMap((dependency) =>
        "task_id" in dependency.task ? [dependency.task.task_id] : []))];
      const expandedBefore = new Map<string, TaskCard>();
      if (existingIds.length) {
        const envelopes = await this.store.readTaskAuthorityRecordEnvelopes(existingIds);
        for (const dependency of input.dependencies ?? []) {
          if (!("task_id" in dependency.task)) continue;
          const index = existingIds.indexOf(dependency.task.task_id);
          const envelope = envelopes[index];
          if (!envelope) throw new TaskGraphValidationError("missing_task", `Existing Task ${dependency.task.task_id} was not found.`);
          const card = projectTaskCard(envelope);
          if ("kind" in card) throw new Error((card as TaskProjectionGap).message);
          if (card.version !== dependency.task.expected_version) {
            throw new TaskGraphValidationError("version_conflict", `Existing dependent Task ${dependency.task.task_id} changed; read it and retry.`);
          }
          expandedBefore.set(card.id, card);
        }
      }

      const graphInput: BeadsGraphCreateInput = {
        operationId: input.operation_id,
        fingerprint,
        nodes: input.tasks.map((task) => ({
          key: task.key,
          title: task.title,
          description: task.goal,
          ...(task.assignee ? { acceptanceCriteria: task.goal, assignee: task.assignee } : {}),
          internalMetadata: { [TASK_METADATA_KEY]: metadata(task.goal) },
        })),
        edges: (input.dependencies ?? []).flatMap((dependency) => dependency.needs.map((need) => ({
          from: edgeRef(dependency.task),
          to: edgeRef(need),
        }))),
      };
      const result = await this.store.createGraphWithResult(graphInput, { actor: "team-lead" });
      const tasksByKey: Record<string, TaskCard> = {};
      for (const task of input.tasks) {
        const card = projectTaskCard(result.tasksByKey[task.key]);
        if ("kind" in card) throw new Error(card.message);
        tasksByKey[task.key] = card;
      }
      const expandedAfterEnvelopes = expandedDependentIds.length
        ? await this.store.readTaskAuthorityRecordEnvelopes(expandedDependentIds)
        : [];
      const expandedTaskChanges = expandedDependentIds.map((taskId, index) => {
        const before = expandedBefore.get(taskId);
        const envelope = expandedAfterEnvelopes[index];
        if (!before || !envelope) throw new TaskGraphValidationError("missing_task", `Existing Task ${taskId} was not available after graph commit.`);
        const after = projectTaskCard(envelope);
        if ("kind" in after) throw new Error((after as TaskProjectionGap).message);
        return { before, after };
      });
      return {
        kind: "created",
        operationId: input.operation_id,
        replayed: result.replayed,
        tasksByKey,
        readyTaskIds: Object.values(tasksByKey)
          .filter((task) => task.status === "open" && task.dependency_state?.kind === "ready")
          .map((task) => task.id)
          .sort(),
        expandedTaskChanges,
        expandedTasks: expandedTaskChanges.map((change) => change.after),
      };
    } catch (error) {
      if (error instanceof TaskGraphValidationError) {
        return {
          kind: "refused",
          operationId: input.operation_id,
          reason: error.code === "worker_unavailable"
            ? "worker_unavailable"
            : error.code === "version_conflict"
              ? "version_conflict"
              : "graph_conflict",
          message: error.message,
        };
      }
      if (error instanceof BeadsError && error.kind === "conflict") {
        return {
          kind: "refused",
          operationId: input.operation_id,
          reason: /operation (?:ID|receipt)/i.test(error.message) ? "operation_conflict" : "graph_conflict",
          message: error.message,
        };
      }
      return {
        kind: "unknown_outcome",
        operationId: input.operation_id,
        message: `Task graph create outcome is unknown after authority interaction: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

export function graphTeamLabel(teamName: string): string {
  return beadsLabel(teamName);
}
