"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RUNTIME_STALE_MS = exports.STARTUP_STALL_MS = exports.HEARTBEAT_STALE_MS = void 0;
exports.runtimeGeneration = runtimeGeneration;
exports.probePidPresence = probePidPresence;
exports.admitRuntimeStartup = admitRuntimeStartup;
exports.writeRuntimeStatus = writeRuntimeStatus;
exports.readRuntimeStatus = readRuntimeStatus;
exports.deleteRuntimeStatus = deleteRuntimeStatus;
exports.cleanupStaleRuntimeFiles = cleanupStaleRuntimeFiles;
exports.createRuntimeError = createRuntimeError;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const lock_1 = require("./lock");
const paths_1 = require("./paths");
/**
 * Runtime constants for health checking.
 * Exported for configurability and testing.
 */
exports.HEARTBEAT_STALE_MS = 90000; // 90 seconds
exports.STARTUP_STALL_MS = 60000; // 60 seconds
exports.RUNTIME_STALE_MS = 300000; // 5 minutes - files older than this are considered stale
function runtimeGeneration(status) {
    if (!status?.membershipId
        || !Number.isSafeInteger(status.pid)
        || status.pid <= 1
        || !Number.isFinite(status.startedAt)
        || status.startedAt <= 0)
        return null;
    return {
        membershipId: status.membershipId,
        pid: status.pid,
        startedAt: status.startedAt,
    };
}
/** ESRCH is the only bounded proof that a recorded PID is absent. */
function probePidPresence(pid) {
    try {
        process.kill(pid, 0);
        return "occupied";
    }
    catch (error) {
        return error.code === "ESRCH" ? "absent" : "occupied";
    }
}
/**
 * Decide startup admission under the exact Membership mutation lease. Runtime
 * status is authoritative only for this bounded process-generation decision.
 */
function admitRuntimeStartup(member, sessionFile, status, pid = process.pid, probe = probePidPresence, launchId) {
    if (!member.membershipId)
        return { kind: "refused", reason: `Current Membership for ${member.name} has no stable identity.` };
    if (!member.sessionFile) {
        if (!member.pendingLaunchId || launchId !== member.pendingLaunchId) {
            return { kind: "refused", reason: `Prepared Membership for ${member.name} has no matching launch capability.` };
        }
        const generation = runtimeGeneration(status);
        if (!generation)
            return status === null
                ? { kind: "admitted", action: "claim" }
                : { kind: "refused", reason: `Runtime evidence for prepared ${member.name} is malformed.` };
        if (generation.membershipId !== member.membershipId) {
            return { kind: "refused", reason: `Runtime evidence for prepared ${member.name} belongs to another Membership.` };
        }
        // A prepared Membership has no completed Session binding. A same-PID
        // record can only be a prior claim whose bind failed, not an idempotent
        // Session re-entry. Keep it fenced until exact exit evidence exists.
        if (probe(generation.pid) === "absent")
            return { kind: "admitted", action: "claim", replaces: generation };
        return { kind: "refused", reason: `Prepared Membership for ${member.name} already has a live or unverified Pi process generation (PID ${generation.pid}).` };
    }
    if (member.sessionFile !== sessionFile) {
        return { kind: "refused", reason: `Session ${sessionFile} is not the current binding for ${member.name}.` };
    }
    const generation = runtimeGeneration(status);
    if (!generation || generation.membershipId !== member.membershipId) {
        return { kind: "refused", reason: `Runtime evidence for already Session-bound ${member.name} is missing, malformed, or belongs to another Membership.` };
    }
    if (generation.pid === pid)
        return { kind: "admitted", action: "already_current" };
    if (probe(generation.pid) === "absent")
        return { kind: "admitted", action: "claim", replaces: generation };
    return { kind: "refused", reason: `Current Membership for ${member.name} already has a live or unverified Pi process generation (PID ${generation.pid}).` };
}
/**
 * Write runtime status for an agent. Merges with existing status.
 */
async function writeRuntimeStatus(teamName, agentName, updates, membershipId) {
    const p = (0, paths_1.runtimeStatusPath)(teamName, agentName);
    const dir = node_path_1.default.dirname(p);
    if (!node_fs_1.default.existsSync(dir))
        node_fs_1.default.mkdirSync(dir, { recursive: true });
    return await (0, lock_1.withLock)(p, async () => {
        let current = {
            teamName,
            agentName,
        };
        if (node_fs_1.default.existsSync(p)) {
            try {
                current = JSON.parse(node_fs_1.default.readFileSync(p, "utf-8"));
            }
            catch {
                // Corrupted file, start fresh
                current = { teamName, agentName };
            }
        }
        const next = {
            ...current,
            ...updates,
            teamName,
            agentName,
            ...(membershipId ? { membershipId } : {}),
        };
        // Readers deliberately do not join producer locks. Publish a complete,
        // restrictive replacement so they observe either generation, never JSON mid-write.
        const temporary = node_path_1.default.join(dir, `.${node_path_1.default.basename(p)}.${process.pid}.${Date.now()}.tmp`);
        let fd;
        try {
            fd = node_fs_1.default.openSync(temporary, "wx", 0o600);
            node_fs_1.default.writeFileSync(fd, JSON.stringify(next, null, 2));
            node_fs_1.default.fsyncSync(fd);
            node_fs_1.default.closeSync(fd);
            fd = undefined;
            node_fs_1.default.renameSync(temporary, p);
        }
        finally {
            if (fd !== undefined)
                try {
                    node_fs_1.default.closeSync(fd);
                }
                catch { }
            try {
                node_fs_1.default.unlinkSync(temporary);
            }
            catch { }
        }
        return next;
    });
}
/**
 * Read runtime status for an agent. Returns null if not found.
 */
async function readRuntimeStatus(teamName, agentName) {
    const p = (0, paths_1.runtimeStatusPath)(teamName, agentName);
    if (!node_fs_1.default.existsSync(p))
        return null;
    return await (0, lock_1.withLock)(p, async () => {
        if (!node_fs_1.default.existsSync(p))
            return null;
        try {
            return JSON.parse(node_fs_1.default.readFileSync(p, "utf-8"));
        }
        catch {
            // Corrupted file
            return null;
        }
    });
}
/**
 * Delete runtime status for an agent. Called during shutdown.
 */
async function deleteRuntimeStatus(teamName, agentName, expected) {
    const p = (0, paths_1.runtimeStatusPath)(teamName, agentName);
    if (!node_fs_1.default.existsSync(p))
        return false;
    return await (0, lock_1.withLock)(p, async () => {
        if (!node_fs_1.default.existsSync(p))
            return false;
        try {
            const current = runtimeGeneration(JSON.parse(node_fs_1.default.readFileSync(p, "utf8")));
            if (!current
                || current.membershipId !== expected.membershipId
                || current.pid !== expected.pid
                || current.startedAt !== expected.startedAt)
                return false;
            node_fs_1.default.unlinkSync(p);
            return true;
        }
        catch {
            return false;
        }
    });
}
/**
 * Clean up stale runtime files for a team.
 * Removes files older than RUNTIME_STALE_MS that have no recent heartbeat.
 * Returns the number of files cleaned up.
 */
async function cleanupStaleRuntimeFiles(teamName, now = Date.now()) {
    const runtimeDir = node_path_1.default.join((0, paths_1.teamDir)(teamName), "runtime");
    if (!node_fs_1.default.existsSync(runtimeDir))
        return 0;
    let cleaned = 0;
    const files = node_fs_1.default.readdirSync(runtimeDir).filter(f => f.endsWith(".json"));
    for (const file of files) {
        const p = node_path_1.default.join(runtimeDir, file);
        try {
            const status = JSON.parse(node_fs_1.default.readFileSync(p, "utf-8"));
            // Check if the file is stale
            const lastActivity = status.lastHeartbeatAt || status.startedAt || 0;
            const isStale = (now - lastActivity) > exports.RUNTIME_STALE_MS;
            if (isStale) {
                await (0, lock_1.withLock)(p, async () => {
                    if (node_fs_1.default.existsSync(p)) {
                        node_fs_1.default.unlinkSync(p);
                        cleaned++;
                    }
                });
            }
        }
        catch {
            // Corrupted file, remove it
            try {
                node_fs_1.default.unlinkSync(p);
                cleaned++;
            }
            catch {
                // Ignore removal errors
            }
        }
    }
    return cleaned;
}
/**
 * Create a structured error object from an error.
 */
function createRuntimeError(error) {
    return {
        message: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
    };
}
