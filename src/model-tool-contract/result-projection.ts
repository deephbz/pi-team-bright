import { Check } from "typebox/value";
import { Type, type Static, type TSchema } from "typebox";
import {
  CandidateAlertSendResultSchema,
  CandidateEnsureWorkerResultSchema,
  CandidateTaskCreateResultSchema,
  CandidateTaskReadResultSchema,
  CandidateTaskUpdateResultSchema,
  CandidateTaskCardSchema,
  CandidateTaskDeltaSchema,
  CandidateTeamDeltaSchema,
  CandidateWorkerDeltaSchema,
  CandidateAlertDeltaSchema,
  CandidateTeamCreateResultSchema,
  CandidateTeamShutdownResultSchema,
  CandidateTeamSyncResultSchema,
  CandidateTaskLinkResultSchema,
  CandidateWorkerStopResultSchema,
  TaskVersionRefSchema,
  MODEL_TOOL_CANDIDATE_LIMITS,
} from "./catalog";
import { taskVersionRef } from "./task-version-ref";
import { CandidateTaskCurrentContextSchema } from "../utils/beads";

export type CandidateProjectedTool =
  | "team_create"
  | "team_sync"
  | "ensure_worker"
  | "task_create"
  | "task_read"
  | "task_update"
  | "worker_stop"
  | "team_shutdown"
  | "task_link"
  | "alert_send";

export const MODEL_RESULT_PROJECTION_VERSION = "2" as const;

const TaskId = Type.String({ minLength: 1, maxLength: 128 });
const TaskVersion = TaskVersionRefSchema;
const WorkerName = Type.String({ minLength: 1, maxLength: 64 });
const TaskStatus = Type.Enum(["open", "in_progress", "blocked", "closed"]);
const TaskCard = Type.Object({
  id: TaskId,
  title: Type.String({ minLength: 1, maxLength: 80 }),
  goal: Type.String({ minLength: 1, maxLength: MODEL_TOOL_CANDIDATE_LIMITS.maxTaskGoalChars }),
  status: TaskStatus,
  assignee: Type.Optional(WorkerName),
  current_context: CandidateTaskCurrentContextSchema,
  version: TaskVersion,
}, { additionalProperties: false });
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

export const CandidateTeamCreateModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("team_created"), team: Type.Object({ name: Type.String(), lifecycle: Type.Literal("active") }, { additionalProperties: false }) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("active_team_exists"), Type.Literal("name_unavailable"), Type.Literal("team_authority_unavailable"), Type.Literal("session_binding_unavailable"), Type.Literal("task_authority_unavailable"), Type.Literal("carrier_unavailable")])),
]);

export const CandidateEnsureWorkerModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("worker_ensured"), effect: Type.Enum(["created", "reused", "reconnected"]), worker: Type.Object({ name: WorkerName, carrier: Type.Enum(["starting", "connected", "absent"]) }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refused"), reason: Type.Literal("name_scope_conflict"), existing_worker: Type.Object({ name: WorkerName, scope: Type.String(), carrier: Type.Enum(["starting", "connected", "absent"]) }, { additionalProperties: false }), message: Type.Optional(Type.String()) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("no_active_team"), Type.Literal("carrier_unavailable"), Type.Literal("team_authority_unavailable")])),
]);

const ProjectedTask = Type.Object({
  id: TaskId,
  status: TaskStatus,
  assignee: Type.Optional(WorkerName),
  version: TaskVersion,
}, { additionalProperties: false });

const CreateOperationId = Type.String({ minLength: 1, maxLength: 128 });
const ProjectedTaskOutcome = Type.Union([
  Type.Object({ kind: Type.Literal("created"), input_index: Type.Integer({ minimum: 0 }), operation_id: CreateOperationId, task: ProjectedTask, delivery_warnings: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refused"), input_index: Type.Integer({ minimum: 0 }), operation_id: CreateOperationId, reason: Type.Enum(["worker_unavailable", "operation_conflict"]), message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("unknown_outcome"), input_index: Type.Integer({ minimum: 0 }), operation_id: CreateOperationId, message: Type.String({ minLength: 1 }), recovery: Type.Object({ action: Type.Literal("retry_same_operation"), operation_id: CreateOperationId }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("unavailable"), input_index: Type.Integer({ minimum: 0 }), operation_id: CreateOperationId, reason: Type.Enum(["no_active_team", "task_authority_unavailable"]), message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);
export const CandidateTaskCreateModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("created"), operation_id: CreateOperationId, task: ProjectedTask, delivery_warnings: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refused"), operation_id: CreateOperationId, reason: Type.Enum(["worker_unavailable", "operation_conflict"]), message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("unknown_outcome"), operation_id: CreateOperationId, message: Type.String({ minLength: 1 }), recovery: Type.Object({ action: Type.Literal("retry_same_operation"), operation_id: CreateOperationId }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("unavailable"), operation_id: CreateOperationId, reason: Type.Enum(["no_active_team", "task_authority_unavailable"]), message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("task_create_batch"), outcomes: Type.Array(ProjectedTaskOutcome) }, { additionalProperties: false }),
]);

const TaskReadOutcome = Type.Union([
  Type.Object({ kind: Type.Literal("found"), input_index: Type.Integer({ minimum: 0 }), task_id: TaskId, task: TaskCard }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("missing"), input_index: Type.Integer({ minimum: 0 }), task_id: TaskId, reason: Type.Literal("task_not_found") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("contract_gap"), input_index: Type.Integer({ minimum: 0 }), task_id: TaskId, reason: Type.Enum(["candidate_metadata_absent", "candidate_metadata_invalid"]), authority_version: TaskVersion, message: Type.String({ minLength: 1 }), recovery: Type.Optional(Recovery) }, { additionalProperties: false }),
]);
export const CandidateTaskReadModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("found"), task: TaskCard }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("missing"), task_id: TaskId, reason: Type.Literal("task_not_found") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("contract_gap"), task_id: TaskId, reason: Type.Enum(["candidate_metadata_absent", "candidate_metadata_invalid"]), authority_version: TaskVersion, message: Type.String({ minLength: 1 }), recovery: Type.Optional(Recovery) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("task_read_batch"), outcomes: Type.Array(TaskReadOutcome) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("no_active_team"), Type.Literal("task_authority_unavailable")])),
]);

const UpdatedTask = Type.Object({ id: TaskId, status: TaskStatus, assignee: Type.Optional(WorkerName), version: TaskVersion }, { additionalProperties: false });
const UpdateOutcome = Type.Union([
  Type.Object({ kind: Type.Literal("updated"), input_index: Type.Integer({ minimum: 0 }), task_id: TaskId, task: UpdatedTask }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refused"), input_index: Type.Integer({ minimum: 0 }), task_id: TaskId, reason: Type.Enum(["task_not_found", "version_conflict", "operation_conflict", "terminal_evidence_required"]), message: Type.String({ minLength: 1 }), current_task: Type.Optional(TaskCard), recovery: Type.Optional(Recovery) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("contract_gap"), input_index: Type.Integer({ minimum: 0 }), task_id: TaskId, reason: Type.Enum(["candidate_metadata_absent", "candidate_metadata_invalid", "beads_external_writer_atomicity_unavailable"]), current_task: Type.Optional(TaskCard), unsupported: Type.Array(Type.String(), { minItems: 1 }), message: Type.String({ minLength: 1 }), recovery: Type.Optional(Recovery) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("unavailable"), input_index: Type.Integer({ minimum: 0 }), task_id: TaskId, reason: Type.Enum(["no_active_team", "task_authority_unavailable"]), message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);
export const CandidateTaskUpdateModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("updated"), task: UpdatedTask }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refused"), task_id: Type.Optional(TaskId), reason: Type.Enum(["task_not_found", "version_conflict", "operation_conflict", "terminal_evidence_required", "duplicate_task_id"]), message: Type.String({ minLength: 1 }), current_task: Type.Optional(TaskCard), recovery: Type.Optional(Recovery) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("contract_gap"), task_id: TaskId, reason: Type.Enum(["candidate_metadata_absent", "candidate_metadata_invalid", "beads_external_writer_atomicity_unavailable"]), current_task: Type.Optional(TaskCard), unsupported: Type.Array(Type.String(), { minItems: 1 }), message: Type.String({ minLength: 1 }), recovery: Type.Optional(Recovery) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("unavailable"), reason: Type.Enum(["no_active_team", "task_authority_unavailable"]), message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("task_update_batch"), outcomes: Type.Array(UpdateOutcome) }, { additionalProperties: false }),
]);

const SyncRecovery = Type.Object({ action: Type.Literal("request_snapshot") }, { additionalProperties: false });
export const CandidateTeamSyncModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("snapshot"), team: Type.Object({ name: Type.String(), purpose: Type.String(), lifecycle: Type.Literal("active") }, { additionalProperties: false }), workers: Type.Array(Type.Object({ name: WorkerName, scope: Type.String(), carrier: Type.Enum(["starting", "connected", "absent"]), nonterminal_task_ids: Type.Array(TaskId) }, { additionalProperties: false })), tasks: Type.Array(TaskCard) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("updates"), team_changes: Type.Array(CandidateTeamDeltaSchema), worker_changes: Type.Array(CandidateWorkerDeltaSchema), task_changes: Type.Array(CandidateTaskDeltaSchema), alerts: Type.Array(CandidateAlertDeltaSchema) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Enum(["snapshot_required", "cancelled"]), message: Type.String({ minLength: 1 }), recovery: Type.Optional(SyncRecovery) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("contract_gap"), reason: Type.Enum(["team_epoch_missing", "logical_workers_missing", "candidate_metadata_absent", "candidate_metadata_invalid", "structured_task_event_evidence_absent"]), message: Type.String({ minLength: 1 }), recovery: Type.Optional(SyncRecovery) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("no_active_team"), Type.Literal("team_state_unavailable"), Type.Literal("task_authority_unavailable")])),
]);

export const CandidateTaskLinkModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("task_linked"), task_id: TaskId, target_id: TaskId, relation: Type.Enum(["blocked_by", "parent", "related"]), action: Type.Enum(["add", "remove"]), changed: Type.Boolean(), version: TaskVersion }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refused"), task_id: TaskId, reason: Type.Enum(["task_not_found", "version_conflict", "graph_conflict"]), message: Type.String({ minLength: 1 }), current_task: Type.Optional(TaskCard), recovery: Type.Optional(Recovery) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("no_active_team"), Type.Literal("task_authority_unavailable")])),
]);

export const CandidateAlertSendModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("alert_sent"), accepted_recipients: Type.Array(WorkerName), failed_recipients: Type.Array(WorkerName), task_id: Type.Optional(TaskId), task_version: Type.Optional(TaskVersion) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refused"), reason: Type.Enum(["recipient_not_current", "no_eligible_recipients", "invalid_fanout"]), message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("no_active_team"), Type.Literal("team_authority_unavailable")])),
]);

export const CandidateWorkerStopModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("worker_stopped"), worker: WorkerName }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refused"), reason: Type.Enum(["worker_not_found", "nonterminal_tasks_assigned", "stop_not_confirmed", "leader_reserved"]), worker: WorkerName, guarding_task_ids: Type.Optional(Type.Array(TaskId)), message: Type.Optional(Type.String()) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("no_active_team"), Type.Literal("team_authority_unavailable"), Type.Literal("carrier_unavailable")])),
]);

export const CandidateTeamShutdownModelResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("team_shutdown"), lifecycle: Type.Literal("stopped"), stopped_workers: Type.Array(WorkerName), unfinished_task_ids: Type.Array(TaskId) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("partial"), lifecycle: Type.Literal("active"), stopped_workers: Type.Array(WorkerName), failed_workers: Type.Array(WorkerName), unfinished_task_ids: Type.Array(TaskId), recovery: Type.Object({ action: Type.Literal("retry_team_shutdown") }, { additionalProperties: false }) }, { additionalProperties: false }),
  ModelFailure(Type.Union([Type.Literal("no_active_team"), Type.Literal("team_authority_unavailable")])),
]);

export const CandidateModelResultSchemas = {
  team_create: CandidateTeamCreateModelResultSchema,
  ensure_worker: CandidateEnsureWorkerModelResultSchema,
  task_create: CandidateTaskCreateModelResultSchema,
  task_read: CandidateTaskReadModelResultSchema,
  task_update: CandidateTaskUpdateModelResultSchema,
  team_sync: CandidateTeamSyncModelResultSchema,
  task_link: CandidateTaskLinkModelResultSchema,
  alert_send: CandidateAlertSendModelResultSchema,
  worker_stop: CandidateWorkerStopModelResultSchema,
  team_shutdown: CandidateTeamShutdownModelResultSchema,
} as const;

export type CandidateToolSemanticResult<TTool extends CandidateProjectedTool> =
  TTool extends "team_create" ? Static<typeof CandidateTeamCreateResultSchema> :
  TTool extends "team_sync" ? Static<typeof CandidateTeamSyncResultSchema> :
  TTool extends "ensure_worker" ? Static<typeof CandidateEnsureWorkerResultSchema> :
  TTool extends "task_create" ? Static<typeof CandidateTaskCreateResultSchema> :
  TTool extends "task_read" ? Static<typeof CandidateTaskReadResultSchema> :
  TTool extends "task_update" ? Static<typeof CandidateTaskUpdateResultSchema> :
  TTool extends "worker_stop" ? Static<typeof CandidateWorkerStopResultSchema> :
  TTool extends "team_shutdown" ? Static<typeof CandidateTeamShutdownResultSchema> :
  TTool extends "task_link" ? Static<typeof CandidateTaskLinkResultSchema> :
  Static<typeof CandidateAlertSendResultSchema>;

export type CandidateModelResult<TTool extends CandidateProjectedTool> = Static<typeof CandidateModelResultSchemas[TTool]>;

export interface CandidateToolResultAssembly<TTool extends CandidateProjectedTool> {
  content: [{ type: "text"; text: string }];
  details: CandidateToolSemanticResult<TTool>;
}

function schemaFor(tool: CandidateProjectedTool): TSchema {
  if (tool === "team_create") return CandidateTeamCreateResultSchema;
  if (tool === "team_sync") return CandidateTeamSyncResultSchema;
  if (tool === "ensure_worker") return CandidateEnsureWorkerResultSchema;
  if (tool === "task_create") return CandidateTaskCreateResultSchema;
  if (tool === "task_read") return CandidateTaskReadResultSchema;
  if (tool === "task_update") return CandidateTaskUpdateResultSchema;
  if (tool === "worker_stop") return CandidateWorkerStopResultSchema;
  if (tool === "team_shutdown") return CandidateTeamShutdownResultSchema;
  if (tool === "task_link") return CandidateTaskLinkResultSchema;
  return CandidateAlertSendResultSchema;
}

function modelSchemaFor(tool: CandidateProjectedTool): TSchema {
  return CandidateModelResultSchemas[tool];
}

function taskSummary(task: any): Record<string, unknown> {
  return {
    id: task.id,
    status: task.status,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    version: taskVersionRef(task.version),
  };
}

/** Authority versions remain raw evidence and never enter a public projection. */
function taskUpdateMessage(raw: any): string {
  return raw.reason === "version_conflict" ? "The supplied Task version is stale." : raw.message;
}

function projectOutcome(tool: CandidateProjectedTool, raw: any): any {
  if (tool === "task_create") {
    if (raw.kind === "task_create_batch") {
      if (raw.outcomes.length === 1) return projectOutcome("task_create", raw.outcomes[0]);
      return { kind: raw.kind, outcomes: raw.outcomes.map((item: any) => {
        const { state_changed: _stateChanged, ...rest } = item;
        const projected = { ...rest, ...(item.task ? { task: taskSummary(item.task) } : {}) };
        return item.kind === "unknown_outcome"
          ? { ...projected, recovery: { action: "retry_same_operation", operation_id: item.operation_id } }
          : projected;
      }) };
    }
    if (raw.kind === "created") return { kind: raw.kind, operation_id: raw.operation_id, task: taskSummary(raw.task), ...(raw.delivery_warnings?.length ? { delivery_warnings: raw.delivery_warnings } : {}) };
    const { state_changed: _stateChanged, input_index: _inputIndex, ...rest } = raw;
    return raw.kind === "unknown_outcome"
      ? { ...rest, recovery: { action: "retry_same_operation", operation_id: raw.operation_id } }
      : rest;
  }
  if (tool === "task_read") {
    if (raw.kind === "task_read_batch") {
      if (raw.outcomes.length === 1) return projectOutcome("task_read", raw.outcomes[0]);
      return { kind: raw.kind, outcomes: raw.outcomes.map((item: any) => {
        if (item.kind === "found") return { ...item, task: { ...item.task, version: taskVersionRef(item.task.version) } };
        const { state_changed: _stateChanged, ...rest } = item;
        return item.kind === "contract_gap"
          ? { ...rest, authority_version: taskVersionRef(item.authority_version), recovery: { action: "request_snapshot" } }
          : rest;
      }) };
    }
    if (raw.kind === "found") return { kind: raw.kind, task: { ...raw.task, version: taskVersionRef(raw.task.version) } };
    if (raw.kind === "missing") return { kind: raw.kind, task_id: raw.task_id, reason: raw.reason };
    if (raw.kind === "contract_gap") {
      const { state_changed: _stateChanged, input_index: _inputIndex, ...rest } = raw;
      return { ...rest, authority_version: taskVersionRef(raw.authority_version), recovery: { action: "request_snapshot" } };
    }
    const { state_changed: _stateChanged, ...rest } = raw;
    return rest;
  }
  if (tool === "task_update") {
    if (raw.kind === "task_update_batch") {
      if (raw.outcomes.length === 1) return projectOutcome("task_update", raw.outcomes[0]);
      return { kind: raw.kind, outcomes: raw.outcomes.map((item: any) => {
        const { state_changed: _stateChanged, operation_id: _operationId, journal_entries: _journalEntries, current_task: _currentTask, ...rest } = item;
        return item.task
          ? { ...rest, task: taskSummary(item.task) }
          : (item.reason === "version_conflict" || item.reason === "operation_conflict") && item.current_task
            ? { ...rest, message: taskUpdateMessage(item), current_task: { ...item.current_task, version: taskVersionRef(item.current_task.version) }, recovery: { action: "reconcile_and_retry", expected_version: taskVersionRef(item.current_task.version), ...(item.reason === "operation_conflict" ? { new_operation_id: true } : {}) } }
            : rest;
      }) };
    }
    if (raw.kind === "updated") return { kind: raw.kind, task: taskSummary(raw.task) };
    const { state_changed: _stateChanged, operation_id: _operationId, input_index: _inputIndex, task_id: _taskId, current_task: _currentTask, ...rest } = raw;
    const withTaskId = raw.kind === "unavailable" ? rest : { ...rest, task_id: _taskId };
    return (raw.reason === "version_conflict" || raw.reason === "operation_conflict") && raw.current_task
      ? { ...withTaskId, message: taskUpdateMessage(raw), current_task: { ...raw.current_task, version: taskVersionRef(raw.current_task.version) }, recovery: { action: "reconcile_and_retry", expected_version: taskVersionRef(raw.current_task.version), ...(raw.reason === "operation_conflict" ? { new_operation_id: true } : {}) } }
      : withTaskId;
  }
  if (tool === "team_sync") {
    if (raw.kind === "snapshot") return {
      ...raw,
      tasks: raw.tasks.map((task: any) => ({ ...task, version: taskVersionRef(task.version) })),
    };
    if (raw.kind === "updates") return {
      ...raw,
      task_changes: raw.task_changes.map((change: any) => ({
        ...change,
        current: { ...change.current, version: taskVersionRef(change.current.version) },
      })),
    };
  }
  if (tool === "team_create" && raw.kind === "team_created") {
    return { kind: raw.kind, team: { name: raw.team.name, lifecycle: raw.team.lifecycle } };
  }
  if (tool === "ensure_worker") {
    if (raw.kind === "worker_ensured") return { kind: raw.kind, effect: raw.effect, worker: { name: raw.worker.name, carrier: raw.worker.carrier } };
    if (raw.kind === "refused") return { kind: raw.kind, reason: raw.reason, existing_worker: raw.existing_worker };
  }
  if (tool === "alert_send" && raw.kind === "alert_sent") {
    return {
      kind: raw.kind,
      accepted_recipients: raw.accepted_recipients,
      failed_recipients: raw.failed_recipients,
      ...(raw.task_id ? { task_id: raw.task_id } : {}),
      ...(raw.task_version ? { task_version: taskVersionRef(raw.task_version) } : {}),
    };
  }
  if (tool === "task_link" && raw.kind === "refused") {
    const { state_changed: _stateChanged, ...rest } = raw;
    return { ...rest, recovery: raw.current_task
      ? { action: "reconcile_and_retry", expected_version: taskVersionRef(raw.current_task.version) }
      : { action: "read_before_retry", task_id: raw.task_id } };
  }
  if (tool === "task_link" && raw.kind === "task_linked") {
    return { ...raw, version: taskVersionRef(raw.version) };
  }
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
  if (raw.kind === "refused" || raw.kind === "unavailable" || raw.kind === "contract_gap" || raw.kind === "cancelled" || raw.kind === "snapshot_required") {
    const { state_changed: _stateChanged, observation_advanced: _observationAdvanced, ...rest } = raw;
    if (tool === "team_sync" && (raw.kind === "contract_gap" || raw.kind === "snapshot_required" || raw.kind === "cancelled")) {
      return { ...rest, ...(raw.kind === "contract_gap" || raw.kind === "snapshot_required" ? { recovery: { action: "request_snapshot" } } : {}) };
    }
    return rest;
  }
  return raw;
}

export function projectCandidateToolResult<TTool extends CandidateProjectedTool>(tool: TTool, result: CandidateToolSemanticResult<TTool>): CandidateModelResult<TTool>;
export function projectCandidateToolResult(tool: CandidateProjectedTool, result: unknown): unknown;
export function projectCandidateToolResult(tool: CandidateProjectedTool, result: unknown): unknown {
  if (!Check(schemaFor(tool), result)) throw new Error(`Invalid semantic result for ${tool}.`);
  const projected = projectOutcome(tool, result);
  if (!Check(modelSchemaFor(tool), projected)) {
    throw new Error(`Invalid model projection for ${tool}.`);
  }
  return projected;
}

export function serializeCandidateToolResult(tool: CandidateProjectedTool, result: unknown): string {
  return JSON.stringify(projectCandidateToolResult(tool, result));
}

export function assembleCandidateToolResult<TTool extends CandidateProjectedTool>(tool: TTool, result: CandidateToolSemanticResult<TTool>): CandidateToolResultAssembly<TTool> {
  if (!Check(schemaFor(tool), result)) throw new Error(`Invalid semantic result for ${tool}.`);
  const model = projectCandidateToolResult(tool, result);
  return { content: [{ type: "text", text: JSON.stringify(model) }], details: result } as CandidateToolResultAssembly<TTool>;
}

export function parseCandidateToolResult(tool: CandidateProjectedTool, content: string): unknown {
  const result: unknown = JSON.parse(content);
  if (!Check(modelSchemaFor(tool), result)) throw new Error(`Invalid model result for ${tool}.`);
  return result;
}