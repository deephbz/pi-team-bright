import * as teams from "../utils/teams";
import type { BeadsTaskAdapterFactory } from "./beads-task-adapter";
import type { TaskOrchestrationPort } from "../task-authority/orchestration";
import type { ModelToolTaskUpdateInput } from "../task-authority/contracts";
import type { GraphTaskOrchestrationPort } from "../task-authority/graph-orchestration";
import type { ModelToolTaskApplicationPort } from "./model-tool-journey-port";
import type {
  CreateTaskGraphPortResult,
  CreateTaskPortResult,
  ExactLeaderSessionId,
  ModelToolGraphTaskUpdateInput,
  ModelToolTaskGraphInput,
  ReadTasksPortResult,
  TaskLinkPortInput,
  TaskLinkPortResult,
  TaskUpdatePortOutcome,
  UpdateTasksPortResult,
} from "./model-tool-contracts";
import { DurableModelToolBindings } from "./durable-model-tool-bindings";

export class DurableModelToolTaskApplication implements ModelToolTaskApplicationPort {
  constructor(
    private readonly bindings: DurableModelToolBindings,
    private readonly factory: BeadsTaskAdapterFactory,
    private readonly legacyOrchestration?: TaskOrchestrationPort,
    private readonly graphOrchestration?: GraphTaskOrchestrationPort,
  ) {}

  async createTaskGraph(id: ExactLeaderSessionId, input: ModelToolTaskGraphInput): Promise<CreateTaskGraphPortResult> {
    const bound = await this.bindings.boundTeam(id);
    if (!bound) return { kind: "no_active_team", operationId: input.operationId };
    if (!this.graphOrchestration) {
      return {
        kind: "unavailable",
        operationId: input.operationId,
        reason: "task_authority_unavailable",
        message: "Graph-native Task orchestration is not attached to the Task application.",
      };
    }
    const outcome = await this.graphOrchestration.applyGraph(bound.teamName, {
      operationId: input.operationId,
      ...(input.expectedGraphVersion ? { expectedGraphVersion: input.expectedGraphVersion } : {}),
      tasks: input.tasks.map((task) => ({
        key: task.key,
        title: task.title,
        goal: task.goal,
        assignee: task.assignee,
        ...(task.model ? { modelAlias: task.model } : {}),
        ...(task.needs ? { needs: [...task.needs] } : {}),
        ...(task.onGoalFailed ? { onGoalFailed: { ...task.onGoalFailed } } : {}),
      })),
    });
    if (outcome.kind !== "applied") return outcome;
    return {
      kind: "created",
      operationId: outcome.operationId,
      replayed: outcome.replayed,
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

  async createTask(id: ExactLeaderSessionId, input: { operationId: string; title: string; goal: string; assignee?: string }): Promise<CreateTaskPortResult> {
    const bound = await this.bindings.boundTeam(id);
    if (!bound) return { kind: "no_active_team", operationId: input.operationId };
    if (!input.assignee || (await teams.readLogicalWorker(bound.teamName, input.assignee)).kind !== "found") {
      return { kind: "worker_unavailable", operationId: input.operationId };
    }
    const result = await this.factory(bound.teamName, "team-lead").createWithReceipt(input);
    return result.kind === "created"
      ? {
        kind: "created",
        operationId: result.operationId,
        task: result.task,
        ...(result.deliveryWarnings.length ? { deliveryWarnings: result.deliveryWarnings } : {}),
      }
      : result;
  }

  async readTasks(id: ExactLeaderSessionId, taskIds: string[]): Promise<ReadTasksPortResult> {
    const bound = await this.bindings.boundTeam(id);
    if (!bound) return { kind: "no_active_team" };
    try {
      if (this.graphOrchestration?.hasGraph(bound.teamName)) {
        const tasks = await this.graphOrchestration.readTasks(bound.teamName, taskIds);
        const byId = new Map(tasks.map((task) => [task.id, task]));
        return { kind: "read", tasks: taskIds.map((taskId) => byId.get(taskId)) };
      }
      const unique = [...new Set(taskIds)];
      const hydrated = await this.factory(bound.teamName, "team-lead").readMany(unique);
      const byId = new Map(unique.map((taskId, index) => [taskId, hydrated[index]]));
      return {
        kind: "read",
        tasks: taskIds.map((taskId) => {
          const result = byId.get(taskId);
          return result === undefined || result.kind === "found" ? result?.task : result;
        }),
      };
    } catch (error) {
      return {
        kind: "unavailable",
        reason: "task_authority_unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async updateTasks(
    id: ExactLeaderSessionId,
    updates: Array<ModelToolTaskUpdateInput | ModelToolGraphTaskUpdateInput>,
    actor = "team-lead",
  ): Promise<UpdateTasksPortResult> {
    const duplicate = new Set<string>();
    const seen = new Set<string>();
    for (const update of updates) {
      if (seen.has(update.taskId)) duplicate.add(update.taskId);
      seen.add(update.taskId);
    }
    if (duplicate.size) return { kind: "duplicate_task_id" };
    const bound = await this.bindings.boundTeam(id);
    if (!bound) return { kind: "no_active_team" };

    if (this.graphOrchestration?.hasGraph(bound.teamName)) {
      const outcomes: TaskUpdatePortOutcome[] = [];
      for (const input of updates) {
        const graphInput = input as ModelToolGraphTaskUpdateInput;
        const result = await this.graphOrchestration.transition(bound.teamName, {
          taskId: graphInput.taskId,
          operationId: graphInput.operationId,
          expectedVersion: graphInput.expectedVersion,
          ...(graphInput.transition ? { transition: graphInput.transition } : {}),
          ...(graphInput.currentContext ? { currentContext: graphInput.currentContext } : {}),
          ...(graphInput.evidence ? { evidence: graphInput.evidence } : {}),
          ...(graphInput.transition && graphInput.transition !== "cancel" ? { worker: actor } : {}),
        }, actor);
        if (result.kind === "updated") {
          outcomes.push({
            kind: "updated",
            taskId: result.task.id,
            operationId: result.operationId,
            replayed: result.replayed,
            task: result.task,
            journalEntries: [],
            transition: result.transition,
            readyTaskIds: result.readyTaskIds,
            ...(result.failureTraversal ? { failureTraversal: result.failureTraversal } : {}),
            ...(result.deliveryWarnings.length ? { deliveryWarnings: result.deliveryWarnings } : {}),
          });
        } else if (result.kind === "refused") {
          outcomes.push({
            kind: "refused",
            taskId: result.taskId,
            operationId: result.operationId,
            reason: result.reason,
            message: result.message,
            ...(result.currentTask ? { currentTask: result.currentTask } : {}),
          });
        } else if (result.kind === "unknown_outcome") {
          outcomes.push({
            kind: "unknown_outcome",
            taskId: result.taskId,
            operationId: result.operationId,
            message: result.message,
          });
        } else {
          outcomes.push({
            kind: "unavailable",
            taskId: result.taskId,
            operationId: result.operationId,
            reason: "task_authority_unavailable",
            message: result.message,
          });
        }
      }
      return { kind: "batch", outcomes };
    }

    const outcomes: TaskUpdatePortOutcome[] = [];
    for (const input of updates as ModelToolTaskUpdateInput[]) {
      const result = await this.factory(bound.teamName, actor).update(input);
      if (result.kind === "updated" || result.kind === "refused") outcomes.push(result);
      else if ("operationId" in result) {
        outcomes.push({
          kind: "contract_gap",
          taskId: result.taskId,
          operationId: result.operationId,
          reason: result.reason,
          message: result.message,
          currentTask: result.currentTask,
          unsupported: [...result.unsupported],
        });
      } else {
        outcomes.push({
          kind: "contract_gap",
          taskId: input.taskId,
          operationId: input.operationId,
          reason: result.reason,
          message: result.message,
          unsupported: ["task_metadata"],
        });
      }
    }
    return { kind: "batch", outcomes };
  }

  async linkTask(id: ExactLeaderSessionId, input: TaskLinkPortInput): Promise<TaskLinkPortResult> {
    const bound = await this.bindings.boundTeam(id);
    if (!bound) {
      return {
        kind: "unavailable",
        reason: "no_active_team",
        message: "The exact leader Session is not bound to an active Team.",
      };
    }
    if (this.graphOrchestration?.hasGraph(bound.teamName)) {
      return {
        kind: "unavailable",
        reason: "task_authority_unavailable",
        message: "Graph relations change only through complete task_graph_apply revisions.",
      };
    }
    const lead = [...bound.config.members].reverse().find((member) => member.name === "team-lead" && member.isActive !== false);
    return this.factory(bound.teamName, "team-lead").link(input, {
      actingSessionFile: bound.sessionFile,
      actingMembershipId: lead?.membershipId,
    });
  }
}
