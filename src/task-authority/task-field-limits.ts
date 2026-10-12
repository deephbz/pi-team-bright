/**
 * Fixed Task field limits. Authoring schemas import these values; readers of
 * stored Tasks never restate them. The configurable goal limit lives in
 * `task-limits.ts`.
 */
export const TASK_ID_MAX_LENGTH = 128;
export const TASK_CARD_TITLE_MAX_LENGTH = 80;
export const TASK_CARD_CONTEXT_MAX_LENGTH = 2_000;
