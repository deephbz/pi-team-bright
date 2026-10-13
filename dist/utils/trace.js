"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PI_TEAMS_TRACE_JSONL_ENV = void 0;
exports.recordBdCall = recordBdCall;
exports.recordBdRunnerLifecycle = recordBdRunnerLifecycle;
exports.recordLockWait = recordLockWait;
exports.recordWorkerLaunchStage = recordWorkerLaunchStage;
exports.withSemanticTrace = withSemanticTrace;
const host_env_1 = require("../env/host-env");
const node_async_hooks_1 = require("node:async_hooks");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
exports.PI_TEAMS_TRACE_JSONL_ENV = "PI_TEAMS_TRACE_JSONL";
const storage = new node_async_hooks_1.AsyncLocalStorage();
function configuredPath() {
    const file = (0, host_env_1.hostEnv)().process.env[exports.PI_TEAMS_TRACE_JSONL_ENV]?.trim();
    if (!file)
        return null;
    if (!node_path_1.default.isAbsolute(file))
        throw new Error(`${exports.PI_TEAMS_TRACE_JSONL_ENV} must be an absolute path.`);
    return file;
}
function append(record) {
    const file = configuredPath();
    if (!file)
        return;
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    node_fs_1.default.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "a" });
}
function recordBdCall(command, durationMs, outcome) {
    storage.getStore()?.bdCalls.push({ command, durationMs, outcome });
}
/** Record payload-free owned-process lifecycle evidence in a semantic trace. */
function recordBdRunnerLifecycle(event, durationMs, timedOut) {
    storage.getStore()?.bdRunnerLifecycle.push({ event, durationMs, timedOut });
}
function recordLockWait(durationMs) {
    const context = storage.getStore();
    if (context)
        context.lockWaitMs += durationMs;
}
/** Record one monotonic, payload-free Worker launch stage in the active trace. */
function recordWorkerLaunchStage(stage, details = {}) {
    const context = storage.getStore();
    if (!context)
        return;
    context.workerLaunchStages.push({
        stage,
        elapsedMs: Math.max(0, performance.now() - context.startedAtMonotonic),
        ...(details.membershipId ? { membershipId: details.membershipId } : {}),
    });
}
/** Emit one payload-free canonical JSONL record for a semantic operation. */
async function withSemanticTrace(operation, identity, action) {
    if (!(0, host_env_1.hostEnv)().process.env[exports.PI_TEAMS_TRACE_JSONL_ENV])
        return action();
    const context = {
        operation,
        ...identity,
        startedAt: (0, host_env_1.hostEnv)().clock.now(),
        startedAtMonotonic: performance.now(),
        bdCalls: [],
        bdRunnerLifecycle: [],
        workerLaunchStages: [],
        lockWaitMs: 0,
    };
    return storage.run(context, async () => {
        let outcome = "ok";
        let caught;
        try {
            return await action();
        }
        catch (error) {
            outcome = "error";
            caught = error;
            throw error;
        }
        finally {
            try {
                append({
                    schemaVersion: 1,
                    timestamp: new Date((0, host_env_1.hostEnv)().clock.now()).toISOString(),
                    operation,
                    ...identity,
                    durationMs: (0, host_env_1.hostEnv)().clock.now() - context.startedAt,
                    bdCallCount: context.bdCalls.length,
                    bdTotalMs: context.bdCalls.reduce((sum, call) => sum + call.durationMs, 0),
                    bdCalls: context.bdCalls,
                    bdRunnerLifecycle: context.bdRunnerLifecycle,
                    ...(context.workerLaunchStages.length > 0 ? {
                        monotonicDurationMs: Math.max(0, performance.now() - context.startedAtMonotonic),
                        workerLaunchStages: context.workerLaunchStages,
                    } : {}),
                    lockWaitMs: context.lockWaitMs,
                    outcome,
                    ...(caught ? { error: {
                            name: caught instanceof Error ? caught.name : "Error",
                            kind: typeof caught?.kind === "string" ? caught.kind : undefined,
                        } } : {}),
                });
            }
            catch (traceError) {
                console.warn(`[pi-teams] trace write failed after ${operation}: ${traceError instanceof Error ? traceError.message : String(traceError)}`);
            }
        }
    });
}
