"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskCardSchema = exports.TaskCardIncompleteSchema = exports.TaskCardCompleteSchema = exports.TaskCardWarningSchema = exports.TaskCardContextSchema = exports.TaskCardStatusSchema = exports.TASK_CARD_CONTEXT_MAX_LENGTH = exports.TASK_CARD_GOAL_MAX_LENGTH = exports.TASK_CARD_TITLE_MAX_LENGTH = void 0;
exports.isTaskCardContext = isTaskCardContext;
exports.isTaskCardGoal = isTaskCardGoal;
const typebox_1 = require("typebox");
const task_version_ref_1 = require("./task-version-ref");
/** Neutral Task contract. This module imports no authority or persistence code. */
exports.TASK_CARD_TITLE_MAX_LENGTH = 80;
exports.TASK_CARD_GOAL_MAX_LENGTH = 1_000;
exports.TASK_CARD_CONTEXT_MAX_LENGTH = 2_000;
exports.TaskCardStatusSchema = typebox_1.Type.Enum(["open", "in_progress", "blocked", "closed"]);
exports.TaskCardContextSchema = typebox_1.Type.String({ minLength: 1, maxLength: exports.TASK_CARD_CONTEXT_MAX_LENGTH });
exports.TaskCardWarningSchema = typebox_1.Type.Object({
    task_id: typebox_1.Type.String({ minLength: 1, maxLength: 128 }),
    truncated_fields: typebox_1.Type.Array(typebox_1.Type.Enum(["title", "goal", "current_context"])),
    incomplete_fields: typebox_1.Type.Array(typebox_1.Type.Enum(["title", "goal", "current_context"])),
    message: typebox_1.Type.String({ minLength: 1 }),
}, { additionalProperties: false });
const TaskCardBase = {
    id: typebox_1.Type.String({ minLength: 1, maxLength: 128 }),
    title: typebox_1.Type.String({ minLength: 1, maxLength: exports.TASK_CARD_TITLE_MAX_LENGTH }),
    status: exports.TaskCardStatusSchema,
    assignee: typebox_1.Type.Optional(typebox_1.Type.String({ minLength: 1, maxLength: 64 })),
    current_context: exports.TaskCardContextSchema,
    version: task_version_ref_1.TaskVersionRefSchema,
};
exports.TaskCardCompleteSchema = typebox_1.Type.Object({
    ...TaskCardBase,
    goal: typebox_1.Type.String({ minLength: 1, maxLength: exports.TASK_CARD_GOAL_MAX_LENGTH }),
    projection_warnings: typebox_1.Type.Optional(typebox_1.Type.Array(exports.TaskCardWarningSchema)),
}, { additionalProperties: false });
exports.TaskCardIncompleteSchema = typebox_1.Type.Object({
    ...TaskCardBase,
    goal_state: typebox_1.Type.Literal("incomplete"),
    projection_warnings: typebox_1.Type.Array(exports.TaskCardWarningSchema, { minItems: 1 }),
}, { additionalProperties: false });
exports.TaskCardSchema = typebox_1.Type.Union([exports.TaskCardCompleteSchema, exports.TaskCardIncompleteSchema]);
function isTaskCardContext(value) {
    return typeof value === "string" && value.length >= 1 && value.length <= exports.TASK_CARD_CONTEXT_MAX_LENGTH;
}
function isTaskCardGoal(value) {
    return typeof value === "string" && value.length >= 1 && value.length <= exports.TASK_CARD_GOAL_MAX_LENGTH;
}
