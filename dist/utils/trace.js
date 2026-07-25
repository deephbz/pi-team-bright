"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PI_TEAMS_TRACE_JSONL_ENV = void 0;
exports.recordBdCall = recordBdCall;
exports.recordLockWait = recordLockWait;
exports.withSemanticTrace = withSemanticTrace;
const node_async_hooks_1 = require("node:async_hooks");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
exports.PI_TEAMS_TRACE_JSONL_ENV = "PI_TEAMS_TRACE_JSONL";
const storage = new node_async_hooks_1.AsyncLocalStorage();
function configuredPath() {
    const file = process.env[exports.PI_TEAMS_TRACE_JSONL_ENV]?.trim();
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
function recordLockWait(durationMs) {
    const context = storage.getStore();
    if (context)
        context.lockWaitMs += durationMs;
}
/** Emit one payload-free canonical JSONL record for a semantic operation. */
async function withSemanticTrace(operation, identity, action) {
    if (!process.env[exports.PI_TEAMS_TRACE_JSONL_ENV])
        return action();
    const context = { operation, ...identity, startedAt: Date.now(), bdCalls: [], lockWaitMs: 0 };
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
                    timestamp: new Date().toISOString(),
                    operation,
                    ...identity,
                    durationMs: Date.now() - context.startedAt,
                    bdCallCount: context.bdCalls.length,
                    bdTotalMs: context.bdCalls.reduce((sum, call) => sum + call.durationMs, 0),
                    bdCalls: context.bdCalls,
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
