/** Compatibility surface for the canonical Task authority card contract. */
export {
  TASK_CARD_TITLE_MAX_LENGTH,
  TASK_CARD_GOAL_MAX_LENGTH,
  TASK_CARD_CONTEXT_MAX_LENGTH,
  TaskCardStatusSchema,
  TaskCardContextSchema,
  TaskCardWarningSchema,
  TaskCardCompleteSchema,
  TaskCardIncompleteSchema,
  TaskCardSchema,
  isTaskCardContext,
  isTaskCardGoal,
} from "../task-authority/task-domain";
export type { TaskCardWarning, TaskCard } from "../task-authority/task-domain";
