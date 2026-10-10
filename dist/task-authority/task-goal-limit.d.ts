export declare const DEFAULT_TASK_GOAL_MAX_LENGTH = 1600;
export declare const TASK_GOAL_MAX_LENGTH_SETTING = "pi_team_bright.task.goal_max_length";
export declare function parseTaskGoalMaxLength(value: unknown): number;
/** Global-only: every Session uses the same contract regardless of Worker cwd. */
export declare function loadTaskGoalMaxLength(agentDir?: string): number;
