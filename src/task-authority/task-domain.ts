import { Type, type Static } from "typebox";
import { TASK_CARD_GOAL_MAX_LENGTH } from "./task-limits";
import { TASK_CARD_CONTEXT_MAX_LENGTH, TASK_CARD_TITLE_MAX_LENGTH, TASK_ID_MAX_LENGTH } from "./task-field-limits";
export { TASK_CARD_GOAL_MAX_LENGTH } from "./task-limits";
export { TASK_CARD_CONTEXT_MAX_LENGTH, TASK_CARD_TITLE_MAX_LENGTH, TASK_ID_MAX_LENGTH } from "./task-field-limits";
import { TaskVersionRefSchema } from "./task-version-ref";
import { GraphTaskCardSchema, type GraphTaskCard } from "./graph-control-schemas";

/** Neutral Task contract. This module imports no authority or persistence code. */

export const TaskCardStatusSchema = Type.Enum(["open", "in_progress", "blocked", "closed"]);
export const TaskCardContextSchema = Type.String({ minLength: 1, maxLength: TASK_CARD_CONTEXT_MAX_LENGTH });
export const TaskCardWarningSchema = Type.Object({
  task_id: Type.String({ minLength: 1, maxLength: TASK_ID_MAX_LENGTH }),
  truncated_fields: Type.Array(Type.Enum(["title", "goal", "current_context"])),
  incomplete_fields: Type.Array(Type.Enum(["title", "goal", "current_context"])),
  message: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const TaskDependencyRelationSchema = Type.Object({
  relation: Type.Enum(["blocked_by", "parent", "related"]),
  target_task_id: Type.String({ minLength: 1, maxLength: TASK_ID_MAX_LENGTH }),
}, { additionalProperties: false });

export const TaskDependencyStateSchema = Type.Union([
  Type.Object({ kind: Type.Literal("ready"), active_blocker_ids: Type.Array(Type.String({ minLength: 1, maxLength: TASK_ID_MAX_LENGTH }), { maxItems: 0 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("waiting"), active_blocker_ids: Type.Array(Type.String({ minLength: 1, maxLength: TASK_ID_MAX_LENGTH }), { minItems: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("terminal"), active_blocker_ids: Type.Array(Type.String({ minLength: 1, maxLength: TASK_ID_MAX_LENGTH })) }, { additionalProperties: false }),
]);

const TaskCardBase = {
  id: Type.String({ minLength: 1, maxLength: TASK_ID_MAX_LENGTH }),
  title: Type.String({ minLength: 1, maxLength: TASK_CARD_TITLE_MAX_LENGTH }),
  status: TaskCardStatusSchema,
  assignee: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  relations: Type.Optional(Type.Array(TaskDependencyRelationSchema)),
  dependency_state: Type.Optional(TaskDependencyStateSchema),
  current_context: TaskCardContextSchema,
  version: TaskVersionRefSchema,
};

export const TaskCardCompleteSchema = Type.Object({
  ...TaskCardBase,
  goal: Type.String({ minLength: 1, maxLength: TASK_CARD_GOAL_MAX_LENGTH }),
  projection_warnings: Type.Optional(Type.Array(TaskCardWarningSchema)),
}, { additionalProperties: false });

export const TaskCardIncompleteSchema = Type.Object({
  ...TaskCardBase,
  goal_state: Type.Literal("incomplete"),
  projection_warnings: Type.Array(TaskCardWarningSchema, { minItems: 1 }),
}, { additionalProperties: false });

/**
 * Historical native Session and delivery records remain readable.
 * Current Task authority writes GraphTaskCard only.
 */
export const TaskCardSchema = Type.Union([TaskCardCompleteSchema, TaskCardIncompleteSchema, GraphTaskCardSchema]);

export function isTaskCardContext(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= TASK_CARD_CONTEXT_MAX_LENGTH;
}

export function isTaskCardGoal(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= TASK_CARD_GOAL_MAX_LENGTH;
}

export type TaskCardWarning = {
  task_id: string;
  truncated_fields: Array<"title" | "goal" | "current_context">;
  incomplete_fields: Array<"title" | "goal" | "current_context">;
  message: string;
};

/** Historical cards remain readable in native Session and delivery records. */
export type LegacyTaskCard = Static<typeof TaskCardCompleteSchema> | Static<typeof TaskCardIncompleteSchema>;
export type TaskCard = LegacyTaskCard;
/** Current graph cards and historical native-record cards share this boundary. */
export type CanonicalTaskCard = LegacyTaskCard | GraphTaskCard;

/** Terminal means no more assigned work can run without a graph revision. */
export function isTaskTerminal(task: CanonicalTaskCard): boolean {
  return task.status === "closed"
    || task.status === "goal_achieved"
    || task.status === "goal_failed"
    || task.status === "cancelled";
}
