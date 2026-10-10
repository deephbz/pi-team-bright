"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TASK_CARD_GOAL_MAX_LENGTH = void 0;
const task_goal_limit_1 = require("./task-goal-limit");
/** Resolve once so schemas and runtime checks agree. Restart Pi after settings edits. */
exports.TASK_CARD_GOAL_MAX_LENGTH = (0, task_goal_limit_1.loadTaskGoalMaxLength)();
