"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TASK_OBSERVATION_SCHEMA = void 0;
exports.readTaskSnapshot = readTaskSnapshot;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const host_env_1 = require("../env/host-env");
const graph_control_1 = require("../task-authority/graph-control");
const graph_card_1 = require("../task-authority/graph-card");
const paths_1 = require("../utils/paths");
exports.TASK_OBSERVATION_SCHEMA = "pi-team-tasks/1";
const cache = new Map();
const fingerprint = (s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
/** Read-only atomic-snapshot projection. A missing/corrupt authority is never an empty graph.
 * Warm reads stat only. No leases, directory creation, runtime probes, or delivery effects.
 */
async function readTaskSnapshot(options) {
    const clock = (0, host_env_1.hostEnv)().clock;
    const result = { schema: exports.TASK_OBSERVATION_SCHEMA, teamName: options.teamName,
        generatedAt: new Date(clock.now()).toISOString(), availability: "unavailable", tasks: [], issues: [] };
    let file;
    const deadline = clock.now() + (options.deadlineMs ?? 1000);
    const check = () => { if (options.signal?.aborted || clock.now() > deadline)
        throw new Error("task_read_interrupted"); };
    try {
        file = node_path_1.default.join(options.teamsRoot ?? paths_1.TEAMS_DIR, (0, paths_1.sanitizeName)(options.teamName), "task-authority", "graph-control.json");
        check();
        const before = await promises_1.default.stat(file, { bigint: true });
        if (!before.isFile() || before.size > 24000000n)
            throw new Error("task_authority_unreadable");
        const identity = fingerprint(before);
        let tasks = cache.get(file)?.identity === identity ? cache.get(file).tasks : undefined;
        if (!tasks) {
            const snapshot = JSON.parse(await promises_1.default.readFile(file, "utf8"));
            check();
            const state = new graph_control_1.GraphObservationRecovery().recover(snapshot);
            const ready = new Set(state.selectReadyFrontier().map(task => task.id));
            tasks = (0, graph_card_1.projectGraphTaskCards)(state).map(task => ({ id: task.id, title: task.title,
                status: task.status, owner: task.assignee, deps: [...task.needs], ready: ready.has(task.id) }));
        }
        if (fingerprint(await promises_1.default.stat(file, { bigint: true })) !== identity)
            throw new Error("task_authority_changed");
        check();
        if (cache.size >= 32)
            cache.delete(cache.keys().next().value);
        cache.set(file, { identity, tasks });
        return { ...result, availability: "available", tasks: structuredClone(tasks) };
    }
    catch (error) {
        if (file)
            cache.delete(file);
        const code = error.code;
        result.issues = [code === "ENOENT" ? "task_authority_missing" : options.signal?.aborted || clock.now() > deadline
                ? "task_read_interrupted" : "task_authority_unavailable"];
        return result;
    }
}
