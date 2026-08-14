import { Check } from "typebox/value";
import { Type, type Static, type TSchema } from "typebox";
import {
  AlertSendResultSchema,
  EnsureWorkerResultSchema,
  TaskCreateResultSchema,
  TaskReadResultSchema,
  TaskUpdateResultSchema,
  TaskDeltaSchema,
  TeamDeltaSchema,
  WorkerDeltaSchema,
  AlertDeltaSchema,
  TeamCreateResultSchema,
  TeamShutdownResultSchema,
  TeamSyncResultSchema,
  TaskLinkResultSchema,
  WorkerStopResultSchema,
  TaskVersionRefSchema,
} from "./catalog";
import type { TaskVersionRef } from "../task-authority/task-version-ref";
import { TaskCardSchema, TaskCardWarningSchema } from "../task-authority/task-domain";

/** task_create is decode-only compatibility; Pi registers task_graph_apply. */
export type ProjectedTool =
  | "team_create"
  | "team_sync"
  | "ensure_worker"
  | "task_graph_apply"
  | "task_create"
  | "task_read"
  | "task_update"
  | "worker_stop"
  | "team_shutdown"
  | "task_link"
  | "alert_send";

export const MODEL_RESULT_PROJECTION_VERSION = "3" as const;

function publicTaskVersion(value: string): TaskVersionRef {
  if (/^v_[0-9a-f]{16}$/.test(value)) return value as TaskVersionRef;
  const error = new Error("Task result contains a non-canonical version; run the stopped-epoch migration.");
  error.name = "upgrade_required";
  throw error;
}

const TaskId = Type.String({ minLength: 1, maxLength: 128 });
const TaskVersion = TaskVersionRefSchema;
const GraphVersion = Type.String({ pattern: "^g_[0-9a-f]{16}$", minLength: 18, maxLength: 18 });
const WorkerName = Type.String({ minLength: 1, maxLength: 64 });
const LegacyTaskStatus = Type.Enum(["open", "in_progress", "blocked", "closed"]);
const GraphTaskStatus = Type.Enum(["dependency_waiting", "ready", "in_progress", "blocked", "goal_failed", "goal_achieved", "cancelled"]);
const TaskStatus = Type.Union([LegacyTaskStatus, GraphTaskStatus]);
const TaskCard = TaskCardSchema;
const Recovery = Type.Union([
  Type.Object({ action: Type.Literal("reconcile_and_retry"), expected_version: TaskVersion, new_operation_id: Type.Optional(Type.Literal(true)) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("retry_same_operation"), operation_id: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("read_before_retry"), task_id: TaskId }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("request_snapshot") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("team_sync") }, { additionalProperties: false }),
]);

const ModelFailure = (reasons: TSchema) => Type.Object({
  kind: Type.Union([Type.Literal("refused"), Type.Literal("unavailable"), Type.Literal("contract_gap"), Type.Literal("cancelled"), Type.Literal("snapshot_required")]),
  reason: reasons,
  message: Type.String({ minLength: 1 }),
  recovery: Type.Optional(Recovery),
}, { additionalProperties: false });

export const TeamCreateModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("team_created"), team: Type.Object({ name: Type.String(), lifecycle: Type.Literal("active") }, { additionalProperties: false }) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("active_team_exists"), Type.Literal("name_unavailable"), Type.Literal("team_authority_unavailable"), Type.Literal("session_binding_unavailable"), Type.Literal("task_authority_unavailable"), Type.Literal("carrier_unavailable")])),
]);

export const EnsureWorkerModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("worker_ensured"), effect: Type.Enum(["created", "reused", "reconnected"]), worker: Type.Object({ name: WorkerName, carrier: Type.Enum(["starting", "connected", "absent"]) }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refused"), reason: Type.Literal("name_scope_conflict"), existing_worker: Type.Object({ name: WorkerName, scope: Type.String(), carrier: Type.Enum(["starting", "connected", "absent"]) }, { additionalProperties: false }), message: Type.Optional(Type.String()) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("no_active_team"), Type.Literal("carrier_unavailable"), Type.Literal("team_authority_unavailable")])),
]);

const ProjectedGraphTask = Type.Object({
  id: TaskId,
  status: GraphTaskStatus,
  assignee: WorkerName,
  model: Type.Enum(["default", "capable"]),
  needs: Type.Array(TaskId),
  state: Type.Unknown(),
  attempts_started: Type.Integer({ minimum: 0 }),
  current_attempt_id: Type.Optional(Type.String({ minLength: 1 })),
  accepted_attempt_id: Type.Optional(Type.String({ minLength: 1 })),
  version: TaskVersion,
}, { additionalProperties: false });

const CreateOperationId = Type.String({ minLength: 1, maxLength: 128 });
export const TaskCreateModelResultSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("task_graph_applied"),
    operation_id: CreateOperationId,
    graph_version: GraphVersion,
    replayed: Type.Boolean(),
    tasks_by_key: Type.Record(Type.String({ pattern: "^[A-Za-z0-9_-]+$" }), ProjectedGraphTask),
    ready_task_ids: Type.Array(TaskId),
    delivery_warnings: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refused"), operation_id: CreateOperationId, reason: Type.Enum(["worker_unavailable", "invalid_graph", "graph_version_conflict", "operation_conflict"]), message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("unknown_outcome"), operation_id: CreateOperationId, message: Type.String({ minLength: 1 }), recovery: Type.Object({ action: Type.Literal("retry_same_operation"), operation_id: CreateOperationId }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("unavailable"), operation_id: CreateOperationId, reason: Type.Enum(["no_active_team", "task_authority_unavailable"]), message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

const TaskReadOutcome = Type.Union([
  Type.Object({ kind: Type.Literal("found"), input_index: Type.Integer({ minimum: 0 }), task_id: TaskId, task: TaskCard }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("missing"), input_index: Type.Integer({ minimum: 0 }), task_id: TaskId, reason: Type.Literal("task_not_found") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("contract_gap"), input_index: Type.Integer({ minimum: 0 }), task_id: TaskId, reason: Type.Enum(["task_metadata_absent", "task_metadata_invalid"]), version: TaskVersion, message: Type.String({ minLength: 1 }), projection_warning: Type.Optional(TaskCardWarningSchema), recovery: Type.Optional(Recovery) }, { additionalProperties: false }),
]);
export const TaskReadModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("found"), task: TaskCard }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("missing"), task_id: TaskId, reason: Type.Literal("task_not_found") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("contract_gap"), task_id: TaskId, reason: Type.Enum(["task_metadata_absent", "task_metadata_invalid"]), version: TaskVersion, message: Type.String({ minLength: 1 }), projection_warning: Type.Optional(TaskCardWarningSchema), recovery: Type.Optional(Recovery) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("task_read_batch"), outcomes: Type.Array(TaskReadOutcome) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("no_active_team"), Type.Literal("task_authority_unavailable")])),
]);

const UpdatedTask = Type.Object({
  id: TaskId,
  status: TaskStatus,
  assignee: Type.Optional(WorkerName),
  version: TaskVersion,
}, { additionalProperties: false });

export const TaskUpdateModelResultSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("updated"),
    operation_id: CreateOperationId,
    replayed: Type.Boolean(),
    transition: Type.Enum(["claim", "block", "resume", "goal_achieved", "goal_failed", "cancel", "context_updated"]),
    task: UpdatedTask,
    ready_task_ids: Type.Array(TaskId),
    failure_traversal: Type.Optional(Type.Object({ source_task_id: TaskId, target_task_id: TaskId, traversal: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })),
    delivery_warnings: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("refused"),
    task_id: TaskId,
    operation_id: CreateOperationId,
    reason: Type.Enum(["task_not_found", "version_conflict", "operation_conflict", "invalid_transition", "legacy_transition_unsupported", "worker_mismatch", "worker_occupied", "evidence_required", "model_alias_unresolved"]),
    message: Type.String({ minLength: 1 }),
    current_task: Type.Optional(TaskCard),
    recovery: Type.Optional(Recovery),
  }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("unknown_outcome"), task_id: TaskId, operation_id: CreateOperationId, message: Type.String({ minLength: 1 }), recovery: Type.Object({ action: Type.Literal("retry_same_operation"), operation_id: CreateOperationId }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("unavailable"), task_id: TaskId, operation_id: CreateOperationId, reason: Type.Enum(["no_active_team", "task_authority_unavailable"]), message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

const SyncRecovery = Type.Object({ action: Type.Literal("request_snapshot") }, { additionalProperties: false });
export const TeamSyncModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("snapshot"), team: Type.Object({ name: Type.String(), purpose: Type.String(), lifecycle: Type.Literal("active") }, { additionalProperties: false }), workers: Type.Array(Type.Object({ name: WorkerName, scope: Type.String(), carrier: Type.Enum(["starting", "connected", "absent"]), nonterminal_task_ids: Type.Array(TaskId) }, { additionalProperties: false })), tasks: Type.Array(TaskCard), task_projection_warnings: Type.Optional(Type.Array(TaskCardWarningSchema)) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("updates"), team_changes: Type.Array(TeamDeltaSchema), worker_changes: Type.Array(WorkerDeltaSchema), task_changes: Type.Array(TaskDeltaSchema), alerts: Type.Array(AlertDeltaSchema), task_projection_warnings: Type.Optional(Type.Array(TaskCardWarningSchema)) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("caught_up"), head: Type.Integer({ minimum: 0 }), epoch_id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("indeterminate"), message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Enum(["snapshot_required", "cancelled"]), message: Type.String({ minLength: 1 }), recovery: Type.Optional(SyncRecovery) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("contract_gap"), reason: Type.Enum(["team_epoch_missing", "logical_workers_missing", "task_metadata_absent", "task_metadata_invalid", "structured_task_event_evidence_absent"]), message: Type.String({ minLength: 1 }), recovery: Type.Optional(SyncRecovery) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("no_active_team"), Type.Literal("team_state_unavailable"), Type.Literal("task_authority_unavailable")])),
]);

export const TaskLinkModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("task_linked"), task_id: TaskId, target_id: TaskId, relation: Type.Enum(["blocked_by", "parent", "related"]), action: Type.Enum(["add", "remove"]), changed: Type.Boolean(), version: TaskVersion }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refused"), task_id: TaskId, reason: Type.Enum(["task_not_found", "version_conflict", "graph_conflict"]), message: Type.String({ minLength: 1 }), current_task: Type.Optional(TaskCard), recovery: Type.Optional(Recovery) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("no_active_team"), Type.Literal("task_authority_unavailable")])),
]);

export const AlertSendModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("alert_sent"), accepted_recipients: Type.Array(WorkerName), failed_recipients: Type.Array(WorkerName), task_id: Type.Optional(TaskId), task_version: Type.Optional(TaskVersion) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refused"), reason: Type.Enum(["recipient_not_current", "no_eligible_recipients", "invalid_fanout"]), message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("no_active_team"), Type.Literal("team_authority_unavailable")])),
]);

export const WorkerStopModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("worker_stopped"), worker: WorkerName }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refused"), reason: Type.Enum(["worker_not_found", "nonterminal_tasks_assigned", "stop_not_confirmed", "leader_reserved"]), worker: WorkerName, guarding_task_ids: Type.Optional(Type.Array(TaskId)), message: Type.Optional(Type.String()) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("no_active_team"), Type.Literal("team_authority_unavailable"), Type.Literal("carrier_unavailable")])),
]);

export const TeamShutdownModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("team_shutdown"), lifecycle: Type.Literal("stopped"), stopped_workers: Type.Array(WorkerName), unfinished_task_ids: Type.Array(TaskId) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("partial"), lifecycle: Type.Literal("active"), stopped_workers: Type.Array(WorkerName), failed_workers: Type.Array(WorkerName), unfinished_task_ids: Type.Array(TaskId), recovery: Type.Object({ action: Type.Literal("retry_team_shutdown") }, { additionalProperties: false }) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("no_active_team"), Type.Literal("team_authority_unavailable")])),
]);

export const ModelResultSchemas = {
  team_create: TeamCreateModelResultSchema,
  ensure_worker: EnsureWorkerModelResultSchema,
  task_graph_apply: TaskCreateModelResultSchema,
  task_create: TaskCreateModelResultSchema,
  task_read: TaskReadModelResultSchema,
  task_update: TaskUpdateModelResultSchema,
  team_sync: TeamSyncModelResultSchema,
  task_link: TaskLinkModelResultSchema,
  alert_send: AlertSendModelResultSchema,
  worker_stop: WorkerStopModelResultSchema,
  team_shutdown: TeamShutdownModelResultSchema,
} as const;

export type ToolSemanticResult<TTool extends ProjectedTool> =
  TTool extends "team_create" ? Static<typeof TeamCreateResultSchema> :
  TTool extends "team_sync" ? Static<typeof TeamSyncResultSchema> :
  TTool extends "ensure_worker" ? Static<typeof EnsureWorkerResultSchema> :
  TTool extends "task_graph_apply" | "task_create" ? Static<typeof TaskCreateResultSchema> :
  TTool extends "task_read" ? Static<typeof TaskReadResultSchema> :
  TTool extends "task_update" ? Static<typeof TaskUpdateResultSchema> :
  TTool extends "worker_stop" ? Static<typeof WorkerStopResultSchema> :
  TTool extends "team_shutdown" ? Static<typeof TeamShutdownResultSchema> :
  TTool extends "task_link" ? Static<typeof TaskLinkResultSchema> :
  Static<typeof AlertSendResultSchema>;

export type ModelResult<TTool extends ProjectedTool> = Static<typeof ModelResultSchemas[TTool]>;

export interface ToolResultAssembly<TTool extends ProjectedTool> {
  content: [{ type: "text"; text: string }];
  details: ToolSemanticResult<TTool>;
}

function schemaFor(tool: ProjectedTool): TSchema {
  if (tool === "team_create") return TeamCreateResultSchema;
  if (tool === "team_sync") return TeamSyncResultSchema;
  if (tool === "ensure_worker") return EnsureWorkerResultSchema;
  if (tool === "task_graph_apply" || tool === "task_create") return TaskCreateResultSchema;
  if (tool === "task_read") return TaskReadResultSchema;
  if (tool === "task_update") return TaskUpdateResultSchema;
  if (tool === "worker_stop") return WorkerStopResultSchema;
  if (tool === "team_shutdown") return TeamShutdownResultSchema;
  if (tool === "task_link") return TaskLinkResultSchema;
  return AlertSendResultSchema;
}

function modelSchemaFor(tool: ProjectedTool): TSchema {
  return ModelResultSchemas[tool];
}

function taskSummary(task: any): Record<string, unknown> {
  return {
    id: task.id,
    status: task.status,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    version: publicTaskVersion(task.version),
  };
}

function graphTaskSummary(task: any): Record<string, unknown> {
  return {
    id: task.id,
    status: task.status,
    assignee: task.assignee,
    model: task.model,
    needs: task.needs,
    state: task.state,
    attempts_started: task.attempts_started,
    ...(task.current_attempt?.id ? { current_attempt_id: task.current_attempt.id } : {}),
    ...(task.accepted_attempt_id ? { accepted_attempt_id: task.accepted_attempt_id } : {}),
    version: publicTaskVersion(task.version),
  };
}

function taskUpdateMessage(raw: any): string {
  return raw.reason === "version_conflict" ? "The supplied Task version is stale." : raw.message;
}

function projectOutcome(tool: ProjectedTool, raw: any): any {
  if (tool === "task_graph_apply" || tool === "task_create") {
    if (raw.kind === "task_graph_applied") return {
      kind: raw.kind,
      operation_id: raw.operation_id,
      graph_version: raw.graph_version,
      replayed: raw.replayed,
      tasks_by_key: Object.fromEntries(Object.entries(raw.tasks_by_key).map(([key, task]) => [key, graphTaskSummary(task)])),
      ready_task_ids: raw.ready_task_ids,
      ...(raw.delivery_warnings?.length ? { delivery_warnings: raw.delivery_warnings } : {}),
    };
    const { state_changed: _stateChanged, ...rest } = raw;
    return raw.kind === "unknown_outcome"
      ? { ...rest, recovery: { action: "retry_same_operation", operation_id: raw.operation_id } }
      : rest;
  }
  if (tool === "task_read") {
    if (raw.kind === "task_read_batch") {
      if (raw.outcomes.length === 1) return projectOutcome("task_read", raw.outcomes[0]);
      return { kind: raw.kind, outcomes: raw.outcomes.map((item: any) => {
        if (item.kind === "found") return { ...item, task: { ...item.task, version: publicTaskVersion(item.task.version) } };
        const { state_changed: _stateChanged, ...rest } = item;
        return item.kind === "contract_gap"
          ? { ...rest, version: publicTaskVersion(item.version), recovery: { action: "request_snapshot" } }
          : rest;
      }) };
    }
    if (raw.kind === "found") return { kind: raw.kind, task: { ...raw.task, version: publicTaskVersion(raw.task.version) } };
    if (raw.kind === "missing") return { kind: raw.kind, task_id: raw.task_id, reason: raw.reason };
    if (raw.kind === "contract_gap") {
      const { state_changed: _stateChanged, input_index: _inputIndex, ...rest } = raw;
      return { ...rest, version: publicTaskVersion(raw.version), recovery: { action: "request_snapshot" } };
    }
    const { state_changed: _stateChanged, ...rest } = raw;
    return rest;
  }
  if (tool === "task_update") {
    if (raw.kind === "updated") return {
      kind: raw.kind,
      operation_id: raw.operation_id,
      replayed: raw.replayed,
      transition: raw.transition,
      task: taskSummary(raw.task),
      ready_task_ids: raw.ready_task_ids,
      ...(raw.failure_traversal ? { failure_traversal: raw.failure_traversal } : {}),
      ...(raw.delivery_warnings?.length ? { delivery_warnings: raw.delivery_warnings } : {}),
    };
    const { state_changed: _stateChanged, input_index: _inputIndex, current_task: _currentTask, ...rest } = raw;
    if (raw.kind === "unknown_outcome") return { ...rest, recovery: { action: "retry_same_operation", operation_id: raw.operation_id } };
    if ((raw.reason === "version_conflict" || raw.reason === "operation_conflict") && raw.current_task) {
      return {
        ...rest,
        message: taskUpdateMessage(raw),
        current_task: { ...raw.current_task, version: publicTaskVersion(raw.current_task.version) },
        recovery: {
          action: "reconcile_and_retry",
          expected_version: publicTaskVersion(raw.current_task.version),
          ...(raw.reason === "operation_conflict" ? { new_operation_id: true } : {}),
        },
      };
    }
    return rest;
  }
  if (tool === "team_sync") {
    if (raw.kind === "snapshot") return {
      ...raw,
      tasks: raw.tasks.map((task: any) => ({ ...task, version: publicTaskVersion(task.version) })),
    };
    if (raw.kind === "updates") return {
      ...raw,
      task_changes: raw.task_changes.map((change: any) => ({
        ...change,
        current: { ...change.current, version: publicTaskVersion(change.current.version) },
      })),
    };
    if (raw.kind === "caught_up" || raw.kind === "indeterminate") {
      const { state_changed: _stateChanged, observation_advanced: _observationAdvanced, ...rest } = raw;
      return rest;
    }
  }
  if (tool === "team_create" && raw.kind === "team_created") return { kind: raw.kind, team: { name: raw.team.name, lifecycle: raw.team.lifecycle } };
  if (tool === "ensure_worker") {
    if (raw.kind === "worker_ensured") return { kind: raw.kind, effect: raw.effect, worker: { name: raw.worker.name, carrier: raw.worker.carrier } };
    if (raw.kind === "refused" && raw.reason === "name_scope_conflict") return { kind: raw.kind, reason: raw.reason, existing_worker: raw.existing_worker };
  }
  if (tool === "alert_send" && raw.kind === "alert_sent") return {
    kind: raw.kind,
    accepted_recipients: raw.accepted_recipients,
    failed_recipients: raw.failed_recipients,
    ...(raw.task_id ? { task_id: raw.task_id } : {}),
    ...(raw.task_version ? { task_version: publicTaskVersion(raw.task_version) } : {}),
  };
  if (tool === "task_link" && raw.kind === "refused") {
    const { state_changed: _stateChanged, ...rest } = raw;
    return { ...rest, recovery: raw.current_task
      ? { action: "reconcile_and_retry", expected_version: publicTaskVersion(raw.current_task.version) }
      : { action: "read_before_retry", task_id: raw.task_id } };
  }
  if (tool === "task_link" && raw.kind === "task_linked") return { ...raw, version: publicTaskVersion(raw.version) };
  if (tool === "worker_stop") {
    if (raw.kind === "worker_stopped") return { kind: raw.kind, worker: raw.worker };
    if (raw.kind === "refused") {
      const { state_changed: _stateChanged, ...rest } = raw;
      return rest;
    }
  }
  if (tool === "team_shutdown" && raw.kind === "partial") {
    const { state_changed: _stateChanged, ...rest } = raw;
    return { ...rest, recovery: { action: "retry_team_shutdown" } };
  }
  if (["refused", "unavailable", "contract_gap", "cancelled", "snapshot_required", "indeterminate"].includes(raw.kind)) {
    const { state_changed: _stateChanged, observation_advanced: _observationAdvanced, ...rest } = raw;
    if (tool === "team_sync" && (raw.kind === "contract_gap" || raw.kind === "snapshot_required" || raw.kind === "cancelled")) {
      return { ...rest, ...(raw.kind === "contract_gap" || raw.kind === "snapshot_required" ? { recovery: { action: "request_snapshot" } } : {}) };
    }
    return rest;
  }
  return raw;
}

function assertCanonicalResultVersions(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertCanonicalResultVersions);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "version" || key === "task_version" || key === "expected_version") && typeof nested === "string" && !/^v_[0-9a-f]{16}$/.test(nested)) {
      const error = new Error("Task result contains a non-canonical version; run the stopped-epoch migration.");
      error.name = "upgrade_required";
      throw error;
    }
    assertCanonicalResultVersions(nested);
  }
}

export function projectToolResult<TTool extends ProjectedTool>(tool: TTool, result: ToolSemanticResult<TTool>): ModelResult<TTool>;
export function projectToolResult(tool: ProjectedTool, result: unknown): unknown;
export function projectToolResult(tool: ProjectedTool, result: unknown): unknown {
  assertCanonicalResultVersions(result);
  if (!Check(schemaFor(tool), result)) throw new Error(`Invalid semantic result for ${tool}.`);
  const projected = projectOutcome(tool, result);
  if (!Check(modelSchemaFor(tool), projected)) throw new Error(`Invalid model projection for ${tool}.`);
  return projected;
}

export function serializeToolResult(tool: ProjectedTool, result: unknown): string {
  return JSON.stringify(projectToolResult(tool, result));
}

export function assembleToolResult<TTool extends ProjectedTool>(tool: TTool, result: ToolSemanticResult<TTool>): ToolResultAssembly<TTool> {
  const model = projectToolResult(tool, result);
  return { content: [{ type: "text", text: JSON.stringify(model) }], details: result } as ToolResultAssembly<TTool>;
}

export function parseToolResult(tool: ProjectedTool, content: string): unknown {
  const result: unknown = JSON.parse(content);
  if (!Check(modelSchemaFor(tool), result)) throw new Error(`Invalid model result for ${tool}.`);
  return result;
}
