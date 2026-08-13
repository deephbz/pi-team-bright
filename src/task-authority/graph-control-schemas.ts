import { Type, type Static } from "typebox";
import { TaskVersionRefSchema } from "./task-version-ref";

const TaskId = Type.String({ minLength: 1, maxLength: 128 });
const TaskKey = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" });
const WorkerName = Type.String({ minLength: 1, maxLength: 64 });
const OperationId = Type.String({ minLength: 1, maxLength: 128 });
export const GraphVersionRefSchema = Type.String({ pattern: "^g_[0-9a-f]{16}$", minLength: 18, maxLength: 18 });
export const GraphControlModelAliasSchema = Type.Enum(["default", "capable"]);
export const GraphTaskTransitionSchema = Type.Enum(["claim", "block", "resume", "goal_achieved", "goal_failed", "cancel"]);

export const GraphFailureEdgeSchema = Type.Object({
  target: TaskKey,
  max_traversals: Type.Integer({ minimum: 1, maximum: 8 }),
}, { additionalProperties: false });

export const GraphTaskStateSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("dependency_waiting"),
    prerequisite_task_ids: Type.Array(TaskId, { minItems: 1 }),
  }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("ready") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("in_progress"), attempt_id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("blocked"),
    attempt_id: Type.String({ minLength: 1 }),
    evidence: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("goal_achieved"),
    attempt_id: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("goal_failed"),
    reason: Type.Literal("criterion_failed"),
    attempt_id: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("goal_failed"),
    reason: Type.Literal("failure_edge_exhausted"),
    attempt_id: Type.String({ minLength: 1 }),
    target_task_id: TaskId,
    traversals: Type.Integer({ minimum: 0 }),
    exhaustion_reason: Type.Enum(["limit_reached", "target_cancelled"]),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("goal_failed"),
    reason: Type.Enum(["dependency_failed", "dependency_cancelled"]),
    prerequisite_task_ids: Type.Array(TaskId, { minItems: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("cancelled"),
    reason: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
]);

export const GraphAttemptSummarySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  ordinal: Type.Integer({ minimum: 1 }),
  resolved_model: Type.String({ minLength: 1 }),
  input_attempt_ids: Type.Record(TaskId, Type.String({ minLength: 1 })),
}, { additionalProperties: false });

/** Canonical graph-native Task card used by tools, delivery, and Coordination. */
export const GraphTaskCardSchema = Type.Object({
  id: TaskId,
  title: Type.String({ minLength: 1, maxLength: 80 }),
  goal: Type.String({ minLength: 1, maxLength: 1_000 }),
  assignee: WorkerName,
  model: GraphControlModelAliasSchema,
  needs: Type.Array(TaskId),
  on_goal_failed: Type.Optional(GraphFailureEdgeSchema),
  status: Type.Enum(["dependency_waiting", "ready", "in_progress", "blocked", "goal_failed", "goal_achieved", "cancelled"]),
  state: GraphTaskStateSchema,
  current_context: Type.String({ minLength: 1, maxLength: 2_000 }),
  version: TaskVersionRefSchema,
  activation_key: Type.Optional(Type.String({ minLength: 1 })),
  accepted_attempt_id: Type.Optional(Type.String({ minLength: 1 })),
  current_attempt: Type.Optional(GraphAttemptSummarySchema),
  attempts_started: Type.Integer({ minimum: 0 }),
  // Optional compatibility coordinates let generic read-only consumers accept
  // both legacy and graph-native cards without making them graph authority.
  relations: Type.Optional(Type.Array(Type.Object({
    relation: Type.Enum(["blocked_by", "parent", "related"]),
    target_task_id: TaskId,
  }, { additionalProperties: false }))),
  dependency_state: Type.Optional(Type.Union([
    Type.Object({ kind: Type.Literal("ready"), active_blocker_ids: Type.Array(TaskId, { maxItems: 0 }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("waiting"), active_blocker_ids: Type.Array(TaskId, { minItems: 1 }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("terminal"), active_blocker_ids: Type.Array(TaskId) }, { additionalProperties: false }),
  ])),
  projection_warnings: Type.Optional(Type.Array(Type.Object({
    task_id: TaskId,
    truncated_fields: Type.Array(Type.Enum(["title", "goal", "current_context"])),
    incomplete_fields: Type.Array(Type.Enum(["title", "goal", "current_context"])),
    message: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }))),
}, { additionalProperties: false });

const GraphTaskItemSchema = Type.Object({
  key: TaskKey,
  title: Type.String({ minLength: 1, maxLength: 80 }),
  goal: Type.String({ minLength: 1, maxLength: 1_000, description: "Desired outcome and external success signal." }),
  assignee: WorkerName,
  model: Type.Optional(GraphControlModelAliasSchema),
  needs: Type.Optional(Type.Array(TaskKey, { uniqueItems: true })),
  on_goal_failed: Type.Optional(GraphFailureEdgeSchema),
}, { additionalProperties: false });

/** Breaking replacement for task_create. It applies one complete graph revision. */
export const TaskGraphApplyParametersSchema = Type.Object({
  operation_id: OperationId,
  expected_graph_version: Type.Optional(GraphVersionRefSchema),
  tasks: Type.Array(GraphTaskItemSchema, { minItems: 1 }),
}, {
  additionalProperties: false,
  description: "Atomically apply the complete assigned Task graph. Omit expected_graph_version only for its first revision.",
});

/** One graph-native Task command. Waiting and ready are derived, never authored. */
export const GraphTaskUpdateParametersSchema = Type.Object({
  task_id: TaskId,
  operation_id: OperationId,
  expected_version: TaskVersionRefSchema,
  transition: Type.Optional(GraphTaskTransitionSchema),
  current_context: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
  evidence: Type.Optional(Type.String({ minLength: 1 })),
}, {
  additionalProperties: false,
  minProperties: 4,
  description: "Apply one explicit Task transition or record current context. dependency_waiting and ready cannot be authored.",
});

export type GraphTaskCard = Static<typeof GraphTaskCardSchema>;
export type GraphTaskStateCard = Static<typeof GraphTaskStateSchema>;
export type TaskGraphApplyParameters = Static<typeof TaskGraphApplyParametersSchema>;
export type GraphTaskUpdateParameters = Static<typeof GraphTaskUpdateParametersSchema>;
