"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GraphTaskUpdateParametersSchema = exports.TaskGraphApplyParametersSchema = exports.GraphTaskCardSchema = exports.GraphAttemptSummarySchema = exports.GraphTaskStateSchema = exports.GraphFailureEdgeSchema = exports.GraphTaskTransitionSchema = exports.GraphControlModelAliasSchema = exports.GraphVersionRefSchema = void 0;
const typebox_1 = require("typebox");
const task_version_ref_1 = require("./task-version-ref");
const TaskId = typebox_1.Type.String({ minLength: 1, maxLength: 128 });
const TaskKey = typebox_1.Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" });
const WorkerName = typebox_1.Type.String({ minLength: 1, maxLength: 64 });
const OperationId = typebox_1.Type.String({ minLength: 1, maxLength: 128 });
exports.GraphVersionRefSchema = typebox_1.Type.String({ pattern: "^g_[0-9a-f]{16}$", minLength: 18, maxLength: 18 });
exports.GraphControlModelAliasSchema = typebox_1.Type.Enum(["default", "capable"]);
exports.GraphTaskTransitionSchema = typebox_1.Type.Enum(["claim", "block", "resume", "goal_achieved", "goal_failed", "cancel"]);
exports.GraphFailureEdgeSchema = typebox_1.Type.Object({
    target: TaskKey,
    max_traversals: typebox_1.Type.Integer({ minimum: 1, maximum: 8 }),
}, { additionalProperties: false });
exports.GraphTaskStateSchema = typebox_1.Type.Union([
    typebox_1.Type.Object({
        kind: typebox_1.Type.Literal("dependency_waiting"),
        prerequisite_task_ids: typebox_1.Type.Array(TaskId, { minItems: 1 }),
    }, { additionalProperties: false }),
    typebox_1.Type.Object({ kind: typebox_1.Type.Literal("ready") }, { additionalProperties: false }),
    typebox_1.Type.Object({ kind: typebox_1.Type.Literal("in_progress"), attempt_id: typebox_1.Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    typebox_1.Type.Object({
        kind: typebox_1.Type.Literal("blocked"),
        attempt_id: typebox_1.Type.String({ minLength: 1 }),
        evidence: typebox_1.Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    typebox_1.Type.Object({
        kind: typebox_1.Type.Literal("goal_achieved"),
        attempt_id: typebox_1.Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    typebox_1.Type.Object({
        kind: typebox_1.Type.Literal("goal_failed"),
        reason: typebox_1.Type.Literal("criterion_failed"),
        attempt_id: typebox_1.Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    typebox_1.Type.Object({
        kind: typebox_1.Type.Literal("goal_failed"),
        reason: typebox_1.Type.Literal("failure_edge_exhausted"),
        attempt_id: typebox_1.Type.String({ minLength: 1 }),
        target_task_id: TaskId,
        traversals: typebox_1.Type.Integer({ minimum: 0 }),
        exhaustion_reason: typebox_1.Type.Enum(["limit_reached", "target_cancelled"]),
    }, { additionalProperties: false }),
    typebox_1.Type.Object({
        kind: typebox_1.Type.Literal("goal_failed"),
        reason: typebox_1.Type.Enum(["dependency_failed", "dependency_cancelled"]),
        prerequisite_task_ids: typebox_1.Type.Array(TaskId, { minItems: 1 }),
    }, { additionalProperties: false }),
    typebox_1.Type.Object({
        kind: typebox_1.Type.Literal("cancelled"),
        reason: typebox_1.Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
]);
exports.GraphAttemptSummarySchema = typebox_1.Type.Object({
    id: typebox_1.Type.String({ minLength: 1 }),
    ordinal: typebox_1.Type.Integer({ minimum: 1 }),
    resolved_model: typebox_1.Type.String({ minLength: 1 }),
    input_attempt_ids: typebox_1.Type.Record(TaskId, typebox_1.Type.String({ minLength: 1 })),
}, { additionalProperties: false });
/** Canonical graph-native Task card used by tools, delivery, and Coordination. */
exports.GraphTaskCardSchema = typebox_1.Type.Object({
    id: TaskId,
    title: typebox_1.Type.String({ minLength: 1, maxLength: 80 }),
    goal: typebox_1.Type.String({ minLength: 1, maxLength: 1_000 }),
    assignee: WorkerName,
    model: exports.GraphControlModelAliasSchema,
    needs: typebox_1.Type.Array(TaskId),
    on_goal_failed: typebox_1.Type.Optional(exports.GraphFailureEdgeSchema),
    status: typebox_1.Type.Enum(["dependency_waiting", "ready", "in_progress", "blocked", "goal_failed", "goal_achieved", "cancelled"]),
    state: exports.GraphTaskStateSchema,
    current_context: typebox_1.Type.String({ minLength: 1, maxLength: 2_000 }),
    version: task_version_ref_1.TaskVersionRefSchema,
    activation_key: typebox_1.Type.Optional(typebox_1.Type.String({ minLength: 1 })),
    accepted_attempt_id: typebox_1.Type.Optional(typebox_1.Type.String({ minLength: 1 })),
    current_attempt: typebox_1.Type.Optional(exports.GraphAttemptSummarySchema),
    attempts_started: typebox_1.Type.Integer({ minimum: 0 }),
    // Optional compatibility coordinates let generic read-only consumers accept
    // both legacy and graph-native cards without making them graph authority.
    relations: typebox_1.Type.Optional(typebox_1.Type.Array(typebox_1.Type.Object({
        relation: typebox_1.Type.Enum(["blocked_by", "parent", "related"]),
        target_task_id: TaskId,
    }, { additionalProperties: false }))),
    dependency_state: typebox_1.Type.Optional(typebox_1.Type.Union([
        typebox_1.Type.Object({ kind: typebox_1.Type.Literal("ready"), active_blocker_ids: typebox_1.Type.Array(TaskId, { maxItems: 0 }) }, { additionalProperties: false }),
        typebox_1.Type.Object({ kind: typebox_1.Type.Literal("waiting"), active_blocker_ids: typebox_1.Type.Array(TaskId, { minItems: 1 }) }, { additionalProperties: false }),
        typebox_1.Type.Object({ kind: typebox_1.Type.Literal("terminal"), active_blocker_ids: typebox_1.Type.Array(TaskId) }, { additionalProperties: false }),
    ])),
    projection_warnings: typebox_1.Type.Optional(typebox_1.Type.Array(typebox_1.Type.Object({
        task_id: TaskId,
        truncated_fields: typebox_1.Type.Array(typebox_1.Type.Enum(["title", "goal", "current_context"])),
        incomplete_fields: typebox_1.Type.Array(typebox_1.Type.Enum(["title", "goal", "current_context"])),
        message: typebox_1.Type.String({ minLength: 1 }),
    }, { additionalProperties: false }))),
}, { additionalProperties: false });
const GraphTaskItemSchema = typebox_1.Type.Object({
    key: TaskKey,
    title: typebox_1.Type.String({ minLength: 1, maxLength: 80 }),
    goal: typebox_1.Type.String({ minLength: 1, maxLength: 1_000, description: "Desired outcome and external success signal." }),
    assignee: WorkerName,
    model: typebox_1.Type.Optional(exports.GraphControlModelAliasSchema),
    needs: typebox_1.Type.Optional(typebox_1.Type.Array(TaskKey, { uniqueItems: true })),
    on_goal_failed: typebox_1.Type.Optional(exports.GraphFailureEdgeSchema),
}, { additionalProperties: false });
/** Breaking replacement for task_create. It applies one complete graph revision. */
exports.TaskGraphApplyParametersSchema = typebox_1.Type.Object({
    operation_id: OperationId,
    expected_graph_version: typebox_1.Type.Optional(exports.GraphVersionRefSchema),
    tasks: typebox_1.Type.Array(GraphTaskItemSchema, { minItems: 1 }),
}, {
    additionalProperties: false,
    description: "Atomically apply the complete assigned Task graph. Omit expected_graph_version only for its first revision.",
});
/** One graph-native Task command. Waiting and ready are derived, never authored. */
exports.GraphTaskUpdateParametersSchema = typebox_1.Type.Object({
    task_id: TaskId,
    operation_id: OperationId,
    expected_version: task_version_ref_1.TaskVersionRefSchema,
    transition: typebox_1.Type.Optional(exports.GraphTaskTransitionSchema),
    current_context: typebox_1.Type.Optional(typebox_1.Type.String({ minLength: 1, maxLength: 2_000 })),
    evidence: typebox_1.Type.Optional(typebox_1.Type.String({ minLength: 1 })),
}, {
    additionalProperties: false,
    minProperties: 4,
    description: "Apply one explicit Task transition or record current context. dependency_waiting and ready cannot be authored.",
});
