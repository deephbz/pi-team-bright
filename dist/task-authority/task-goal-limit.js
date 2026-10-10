"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TASK_GOAL_MAX_LENGTH_SETTING = exports.DEFAULT_TASK_GOAL_MAX_LENGTH = void 0;
exports.parseTaskGoalMaxLength = parseTaskGoalMaxLength;
exports.loadTaskGoalMaxLength = loadTaskGoalMaxLength;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
exports.DEFAULT_TASK_GOAL_MAX_LENGTH = 1_600;
exports.TASK_GOAL_MAX_LENGTH_SETTING = "pi_team_bright.task.goal_max_length";
function parseTaskGoalMaxLength(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${exports.TASK_GOAL_MAX_LENGTH_SETTING} must be a positive safe integer.`);
    }
    return value;
}
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** Global-only: every Session uses the same contract regardless of Worker cwd. */
function loadTaskGoalMaxLength(agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")) {
    const file = path.join(agentDir, "settings.json");
    let root;
    try {
        root = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return exports.DEFAULT_TASK_GOAL_MAX_LENGTH;
        throw new Error(`Cannot load ${exports.TASK_GOAL_MAX_LENGTH_SETTING} from ${file}.`, { cause: error });
    }
    if (!isRecord(root) || !Object.hasOwn(root, "pi_team_bright"))
        return exports.DEFAULT_TASK_GOAL_MAX_LENGTH;
    const namespace = root.pi_team_bright;
    if (!isRecord(namespace))
        throw new Error("pi_team_bright must be an object.");
    if (!Object.hasOwn(namespace, "task"))
        return exports.DEFAULT_TASK_GOAL_MAX_LENGTH;
    if (!isRecord(namespace.task))
        throw new Error("pi_team_bright.task must be an object.");
    return Object.hasOwn(namespace.task, "goal_max_length")
        ? parseTaskGoalMaxLength(namespace.task.goal_max_length)
        : exports.DEFAULT_TASK_GOAL_MAX_LENGTH;
}
