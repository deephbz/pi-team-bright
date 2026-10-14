import type { GraphTaskOrchestrationPort } from "../task-authority/graph-orchestration";
import type { ModelToolTaskApplicationPort } from "./model-tool-journey-port";
import type {
  CreateTaskGraphPortResult,
  ExactLeaderSessionId,
  ModelToolGraphTaskUpdateInput,
  ModelToolTaskGraphInput,
  ReadTasksPortResult,
  TaskUpdatePortOutcome,
  UpdateTasksPortResult,
} from "./model-tool-contracts";
import { DurableModelToolBindings } from "./durable-model-tool-bindings";

export class DurableModelToolTaskApplication implements ModelToolTaskApplicationPort {
  constructor(
    private readonly bindings: DurableModelToolBindings,
    private readonly graph: GraphTaskOrchestrationPort,
  ) {}

  async createTaskGraph(id: ExactLeaderSessionId, input: ModelToolTaskGraphInput): Promise<CreateTaskGraphPortResult> {
    const bound = await this.bindings.boundTeam(id);
    if (!bound) return { kind: "no_active_team", operationId: input.operationId };
    const outcome = await this.graph.applyGraph(bound.teamName, {
      operationId: input.operationId,
      ...(input.expectedGraphVersion ? { expectedGraphVersion: input.expectedGraphVersion } : {}),
      tasks: input.tasks.map((task) => ({
        key: task.key, title: task.title, goal: task.goal, assignee: task.assignee,
        ...(task.needs ? { needs: [...task.needs] } : {}),
        ...(task.onGoalFailed ? { onGoalFailed: { ...task.onGoalFailed } } : {}),
      })),
    });
    if (outcome.kind !== "applied") return outcome;
    return {
      kind: "created", operationId: outcome.operationId, replayed: outcome.replayed,
      graphVersion: outcome.graphVersion,
      tasksByKey: Object.fromEntries(input.tasks.map((definition) => {
        const task = outcome.tasks.find((candidate) => candidate.id === definition.key);
        if (!task) throw new Error(`Applied graph omitted Task key ${definition.key}.`);
        return [definition.key, task];
      })),
      readyTaskIds: outcome.readyTaskIds,
      ...(outcome.deliveryWarnings.length ? { deliveryWarnings: outcome.deliveryWarnings } : {}),
    };
  }

  async readTasks(id: ExactLeaderSessionId, taskIds: string[]): Promise<ReadTasksPortResult> {
    const bound = await this.bindings.boundTeam(id);
    if (!bound) return { kind: "no_active_team" };
    try {
      const tasks = await this.graph.readTasks(bound.teamName, taskIds);
      const byId = new Map(tasks.map((task) => [task.id, task]));
      return { kind: "read", tasks: taskIds.map((taskId) => byId.get(taskId)) };
    } catch (error) {
      return { kind: "unavailable", reason: "task_authority_unavailable", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async updateTasks(id: ExactLeaderSessionId, updates: ModelToolGraphTaskUpdateInput[], actor = "team-lead"): Promise<UpdateTasksPortResult> {
    if (new Set(updates.map((update) => update.taskId)).size !== updates.length) return { kind: "duplicate_task_id" };
    const bound = await this.bindings.boundTeam(id);
    if (!bound) return { kind: "no_active_team" };
    const outcomes: TaskUpdatePortOutcome[] = [];
    for (const input of updates) {
      const result = await this.graph.transition(bound.teamName, {
        taskId: input.taskId, operationId: input.operationId, expectedVersion: input.expectedVersion,
        ...(input.transition ? { transition: input.transition } : {}),
        ...(input.currentContext ? { currentContext: input.currentContext } : {}),
        ...(input.evidence ? { evidence: input.evidence } : {}),
        ...(input.transition && input.transition !== "cancel" ? { worker: actor } : {}),
      }, actor);
      if (result.kind === "updated") {
        outcomes.push({
          kind: "updated", taskId: result.task.id, operationId: result.operationId,
          replayed: result.replayed, task: result.task, journalEntries: [], transition: result.transition,
          readyTaskIds: result.readyTaskIds,
          ...(result.failureTraversal ? { failureTraversal: result.failureTraversal } : {}),
          ...(result.deliveryWarnings.length ? { deliveryWarnings: result.deliveryWarnings } : {}),
        });
      } else if (result.kind === "refused") {
        outcomes.push({ kind: "refused", taskId: result.taskId, operationId: result.operationId,
          reason: result.reason, message: result.message, ...(result.currentTask ? { currentTask: result.currentTask } : {}) });
      } else if (result.kind === "unknown_outcome") {
        outcomes.push({ kind: "unknown_outcome", taskId: result.taskId, operationId: result.operationId, message: result.message });
      } else {
        outcomes.push({ kind: "unavailable", taskId: result.taskId, operationId: result.operationId,
          reason: "task_authority_unavailable", message: result.message });
      }
    }
    return { kind: "batch", outcomes };
  }
}
