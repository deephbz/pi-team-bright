"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TASK_CARD_CONTEXT_MAX_LENGTH = exports.TASK_CARD_TITLE_MAX_LENGTH = exports.TASK_ID_MAX_LENGTH = void 0;
/**
 * Fixed Task field limits. Authoring schemas import these values; readers of
 * stored Tasks never restate them. The configurable goal limit lives in
 * `task-limits.ts`.
 */
exports.TASK_ID_MAX_LENGTH = 128;
exports.TASK_CARD_TITLE_MAX_LENGTH = 80;
exports.TASK_CARD_CONTEXT_MAX_LENGTH = 2_000;
