import * as teams from "../utils/teams";
import type { BeadsTaskAdapterFactory } from "./beads-task-adapter";
import type { TaskOrchestrationPort } from "../task-authority/orchestration";
import type { ModelToolTaskUpdateInput } from "../task-authority/contracts";
import type { ModelToolTaskApplicationPort } from "./model-tool-journey-port";
import type { CreateTaskGraphPortResult, CreateTaskPortResult, ExactLeaderSessionId, ModelToolTaskGraphInput, ReadTasksPortResult, TaskLinkPortInput, TaskLinkPortResult, TaskUpdatePortOutcome, UpdateTasksPortResult } from "./model-tool-contracts";
import { DurableModelToolBindings } from "./durable-model-tool-bindings";
export class DurableModelToolTaskApplication implements ModelToolTaskApplicationPort {
  constructor(
    private readonly bindings: DurableModelToolBindings,
    private readonly factory: BeadsTaskAdapterFactory,
    private readonly orchestration?: TaskOrchestrationPort,
  ) {}
  async createTaskGraph(id: ExactLeaderSessionId, input: ModelToolTaskGraphInput): Promise<CreateTaskGraphPortResult> {
    const bound = await this.bindings.boundTeam(id);
    if (!bound) return { kind: "no_active_team", operationId: input.operationId };
    if (!this.orchestration) return { kind: "unavailable", operationId: input.operationId, reason: "task_authority_unavailable", message: "Task graph orchestration is not attached to the Task application." };
    return this.orchestration.createGraph(bound.teamName, {
      operation_id: input.operationId,
      tasks: input.tasks.map(({ needs: _needs, ...task }) => task),
      dependencies: input.tasks.flatMap(task => task.needs?.length
        ? [{ task: { key: task.key }, needs: task.needs.map(key => ({ key })) }]
        : []),
    });
  }
  async createTask(id: ExactLeaderSessionId, input: { operationId: string; title: string; goal: string; assignee?: string }): Promise<CreateTaskPortResult> { const bound = await this.bindings.boundTeam(id); if (!bound) return { kind: "no_active_team", operationId: input.operationId }; if (input.assignee && (await teams.readLogicalWorker(bound.teamName, input.assignee)).kind !== "found") return { kind: "worker_unavailable", operationId: input.operationId }; const result = await this.factory(bound.teamName, "team-lead").createWithReceipt(input); return result.kind === "created" ? { kind: "created", operationId: result.operationId, task: result.task, ...(result.deliveryWarnings.length ? { deliveryWarnings: result.deliveryWarnings } : {}) } : result; }
  async readTasks(id: ExactLeaderSessionId, ids: string[]): Promise<ReadTasksPortResult> { const bound = await this.bindings.boundTeam(id); if (!bound) return { kind: "no_active_team" }; try { const unique = [...new Set(ids)]; const hydrated = await this.factory(bound.teamName, "team-lead").readMany(unique); const byId = new Map(unique.map((taskId, index) => [taskId, hydrated[index]])); return { kind: "read", tasks: ids.map((taskId) => { const result = byId.get(taskId); return result === undefined || result.kind === "found" ? result?.task : result; }) }; } catch (error) { return { kind: "unavailable", reason: "task_authority_unavailable", message: error instanceof Error ? error.message : String(error) }; } }
  async updateTasks(id: ExactLeaderSessionId, updates: ModelToolTaskUpdateInput[]): Promise<UpdateTasksPortResult> { const duplicate = new Set<string>(); const seen = new Set<string>(); for (const update of updates) { if (seen.has(update.taskId)) duplicate.add(update.taskId); seen.add(update.taskId); } if (duplicate.size) return { kind: "duplicate_task_id" }; const bound = await this.bindings.boundTeam(id); if (!bound) return { kind: "no_active_team" }; const outcomes: TaskUpdatePortOutcome[] = []; for (const input of updates) { const result = await this.factory(bound.teamName, "team-lead").update(input); if (result.kind === "updated" || result.kind === "refused") outcomes.push(result); else if ("operationId" in result) outcomes.push({ kind: "contract_gap", taskId: result.taskId, operationId: result.operationId, reason: result.reason, message: result.message, currentTask: result.currentTask, unsupported: [...result.unsupported] }); else outcomes.push({ kind: "contract_gap", taskId: input.taskId, operationId: input.operationId, reason: result.reason, message: result.message, unsupported: ["task_metadata"] }); } return { kind: "batch", outcomes }; }
  async linkTask(id: ExactLeaderSessionId, input: TaskLinkPortInput): Promise<TaskLinkPortResult> { const bound = await this.bindings.boundTeam(id); if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." }; const lead = [...bound.config.members].reverse().find((m) => m.name === "team-lead" && m.isActive !== false); return this.factory(bound.teamName, "team-lead").link(input, { actingSessionFile: bound.sessionFile, actingMembershipId: lead?.membershipId }); }
}
