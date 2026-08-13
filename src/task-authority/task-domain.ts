import { Type, type Static } from "typebox";
import { TaskVersionRefSchema } from "./task-version-ref";

/** Neutral Task contract. This module imports no authority or persistence code. */
export const TASK_CARD_TITLE_MAX_LENGTH = 80;
export const TASK_CARD_GOAL_MAX_LENGTH = 1_000;
export const TASK_CARD_CONTEXT_MAX_LENGTH = 2_000;

export const TaskCardStatusSchema = Type.Enum(["open", "in_progress", "blocked", "closed"]);
export const TaskCardContextSchema = Type.String({ minLength: 1, maxLength: TASK_CARD_CONTEXT_MAX_LENGTH });
export const TaskCardWarningSchema = Type.Object({
  task_id: Type.String({ minLength: 1, maxLength: 128 }),
  truncated_fields: Type.Array(Type.Enum(["title", "goal", "current_context"])),
  incomplete_fields: Type.Array(Type.Enum(["title", "goal", "current_context"])),
  message: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const TaskDependencyRelationSchema = Type.Object({
  relation: Type.Enum(["blocked_by", "parent", "related"]),
  target_task_id: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });

export const TaskDependencyStateSchema = Type.Union([
  Type.Object({ kind: Type.Literal("ready"), active_blocker_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 0 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("waiting"), active_blocker_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("terminal"), active_blocker_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 })) }, { additionalProperties: false }),
]);

const TaskCardBase = {
  id: Type.String({ minLength: 1, maxLength: 128 }),
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

export const TaskCardSchema = Type.Union([TaskCardCompleteSchema, TaskCardIncompleteSchema]);

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

/** DAG fields are optional only for stored pre-DAG cards during migration. */
export type TaskCard = Static<typeof TaskCardCompleteSchema> | Static<typeof TaskCardIncompleteSchema>;
