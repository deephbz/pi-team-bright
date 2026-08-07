"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TASKS_DIR = exports.TEAMS_DIR = exports.PI_DIR = void 0;
exports.ensureDirs = ensureDirs;
exports.sanitizeName = sanitizeName;
exports.teamDir = teamDir;
exports.taskDir = taskDir;
exports.inboxPath = inboxPath;
exports.taskDeliveryPath = taskDeliveryPath;
exports.taskDeliveryTombstonePath = taskDeliveryTombstonePath;
exports.taskDeliveryRecoveryPath = taskDeliveryRecoveryPath;
exports.taskOwnerTransitionOutboxPath = taskOwnerTransitionOutboxPath;
exports.teamEventJournalPath = teamEventJournalPath;
exports.teamEventCursorStatePath = teamEventCursorStatePath;
exports.taskEventFailureHintPath = taskEventFailureHintPath;
exports.runtimeStatusPath = runtimeStatusPath;
exports.configPath = configPath;
exports.leadSessionPath = leadSessionPath;
exports.syncNudgeRecordPath = syncNudgeRecordPath;
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
exports.PI_DIR = node_path_1.default.join(node_os_1.default.homedir(), ".pi");
exports.TEAMS_DIR = node_path_1.default.join(exports.PI_DIR, "teams");
exports.TASKS_DIR = node_path_1.default.join(exports.PI_DIR, "tasks");
function ensureDirs() {
    if (!node_fs_1.default.existsSync(exports.PI_DIR))
        node_fs_1.default.mkdirSync(exports.PI_DIR);
    if (!node_fs_1.default.existsSync(exports.TEAMS_DIR))
        node_fs_1.default.mkdirSync(exports.TEAMS_DIR);
    if (!node_fs_1.default.existsSync(exports.TASKS_DIR))
        node_fs_1.default.mkdirSync(exports.TASKS_DIR);
}
function sanitizeName(name) {
    // Allow only alphanumeric characters, hyphens, and underscores.
    if (!name) {
        throw new Error("Invalid name: names must not be empty.");
    }
    if (/[^a-zA-Z0-9_-]/.test(name)) {
        throw new Error(`Invalid name: "${name}". Only alphanumeric characters, hyphens, and underscores are allowed.`);
    }
    return name;
}
function teamDir(teamName) {
    return node_path_1.default.join(exports.TEAMS_DIR, sanitizeName(teamName));
}
function taskDir(teamName) {
    return node_path_1.default.join(exports.TASKS_DIR, sanitizeName(teamName));
}
function inboxPath(teamName, agentName) {
    return node_path_1.default.join(teamDir(teamName), "inboxes", `${sanitizeName(agentName)}.json`);
}
/** Task-authority-local delivery evidence for one resolved recipient. */
function taskDeliveryPath(teamName, agentName) {
    return node_path_1.default.join(teamDir(teamName), "task-delivery", `${sanitizeName(agentName)}.json`);
}
function taskDeliveryTombstonePath(teamName, agentName) {
    return node_path_1.default.join(teamDir(teamName), "task-delivery", `${sanitizeName(agentName)}.observed.json`);
}
function taskDeliveryRecoveryPath(teamName) {
    return node_path_1.default.join(teamDir(teamName), "task-delivery", "recovery.json");
}
/** Durable adapter intent for Task ownership-change delivery recovery. */
function taskOwnerTransitionOutboxPath(teamName) {
    // Keep the historical filename: changing it would orphan unresolved durable
    // recovery evidence during an otherwise agent-surface-only migration.
    return node_path_1.default.join(teamDir(teamName), "task-delivery", "owner-transitions.json");
}
/** Append-only, Team-scoped coordination evidence consumed by team_sync. */
function teamEventJournalPath(teamName) {
    return node_path_1.default.join(teamDir(teamName), "events", "team-events.jsonl");
}
/** Disposable latest-cursor projection; the append-only journal remains authoritative. */
function teamEventCursorStatePath(teamName) {
    return node_path_1.default.join(teamDir(teamName), "events", "cursor.json");
}
/** Durable derived hints for committed Task mutations whose event append failed. */
function taskEventFailureHintPath(teamName) {
    return node_path_1.default.join(teamDir(teamName), "events", "task-event-failure-hints.jsonl");
}
function runtimeStatusPath(teamName, agentName) {
    return node_path_1.default.join(teamDir(teamName), "runtime", `${sanitizeName(agentName)}.json`);
}
function configPath(teamName) {
    return node_path_1.default.join(teamDir(teamName), "config.json");
}
function leadSessionPath(teamName) {
    return node_path_1.default.join(teamDir(teamName), "lead-session.json");
}
/** Derived presentation evidence for internal sync nudges. */
function syncNudgeRecordPath(teamName) {
    return node_path_1.default.join(teamDir(teamName), "sync-nudges.jsonl");
}
