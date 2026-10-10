import { loadTaskGoalMaxLength } from "./task-goal-limit";

/** Resolve once so schemas and runtime checks agree. Restart Pi after settings edits. */
export const TASK_CARD_GOAL_MAX_LENGTH = loadTaskGoalMaxLength();
