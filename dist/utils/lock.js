"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LockDeadlineError = void 0;
exports.withLockDeadline = withLockDeadline;
exports.assertLockDeadline = assertLockDeadline;
exports.withUnboundedLockWait = withUnboundedLockWait;
exports.withLock = withLock;
exports.withLocks = withLocks;
const host_env_1 = require("../env/host-env");
// Project: pi-teams
const node_async_hooks_1 = require("node:async_hooks");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const trace_1 = require("./trace");
const LEGACY_RETRY_INTERVAL_MS = 100;
const RETRY_MIN_DELAY_MS = 5;
const RETRY_MAX_DELAY_MS = 15;
const STALE_LOCK_TIMEOUT = 30_000;
const HEARTBEAT_INTERVAL_MS = Math.floor(STALE_LOCK_TIMEOUT / 3);
function ownerText(owner) {
    return JSON.stringify(owner);
}
function sameOwner(left, right) {
    return left?.pid === right.pid && left.token === right.token;
}
function parseOwner(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object"
            && parsed !== null
            && Number.isSafeInteger(parsed.pid)
            && parsed.pid > 0
            && typeof parsed.token === "string"
            && parsed.token.length > 0) {
            return { pid: parsed.pid, token: parsed.token };
        }
    }
    catch { }
    // Previous releases wrote only the PID. JSON.parse accepts a numeric PID,
    // so this fallback must run after both successful and failed JSON parsing.
    const legacyPid = Number(raw.trim());
    if (Number.isSafeInteger(legacyPid) && legacyPid > 0) {
        return { pid: legacyPid, token: "legacy" };
    }
    return null;
}
function readOwner(file) {
    try {
        return parseOwner(node_fs_1.default.readFileSync(file, "utf8"));
    }
    catch {
        return null;
    }
}
function ownerMatches(file, owner) {
    return sameOwner(readOwner(file), owner);
}
function processIsAlive(pid) {
    if (!pid)
        return false;
    try {
        (0, host_env_1.hostEnv)().process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error?.code === "EPERM";
    }
}
function createOwnerFile(file, owner) {
    try {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
        node_fs_1.default.writeFileSync(file, ownerText(owner), { flag: "wx", mode: 0o600 });
    }
    catch (error) {
        if (error?.code === "EEXIST")
            return false;
        throw error;
    }
    try {
        const now = new Date((0, host_env_1.hostEnv)().clock.now());
        node_fs_1.default.utimesSync(file, now, now);
        return true;
    }
    catch (error) {
        // Metadata failure must not strand the new lock or recovery claim.
        // A replaced pathname belongs to its successor and must remain intact.
        if (ownerMatches(file, owner)) {
            try {
                node_fs_1.default.unlinkSync(file);
            }
            catch { }
        }
        throw error;
    }
}
function lockAgeMs(file) {
    try {
        return (0, host_env_1.hostEnv)().clock.now() - node_fs_1.default.statSync(file).mtimeMs;
    }
    catch {
        return null;
    }
}
function abandonedRecoveryError(claimFile) {
    return new Error(`Lock recovery claim ${claimFile} is abandoned or malformed. ` +
        "Failing closed: verify that no recovery process is running, then remove this claim manually and retry.");
}
/**
 * Recover one dead stale visible owner. Normal contenders never need this
 * claim: they race only on the visible lock's atomic `wx` creation. The fixed
 * claim serializes the sole pathname-unlink transition, so no contender can
 * unlink a successor after observing an older owner (the previous ABA bug).
 *
 * An orphaned claim is deliberately not stolen recursively. Manual recovery is
 * rarer and safer than inventing another stale-takeover protocol for the guard.
 */
function recoverStaleVisibleLock(lockFile, observedOwner, contender) {
    const claimFile = `${lockFile}.recovery`;
    const claimOwner = { pid: (0, host_env_1.hostEnv)().process.pid, token: (0, host_env_1.hostEnv)().random.uuid() };
    if (!createOwnerFile(claimFile, claimOwner)) {
        const claimAge = lockAgeMs(claimFile);
        // A losing exclusive create proves a competing claimer existed, but that
        // claimer can finish and remove the fixed claim before this contender reads
        // it. A missing pathname is ordinary contention and must retry. `wx` also
        // makes a young unreadable claim an in-progress acquisition, not abandoned
        // evidence. Only a present stale claim with no live owner fails closed.
        if (claimAge === null || claimAge <= STALE_LOCK_TIMEOUT)
            return false;
        const currentClaim = readOwner(claimFile);
        if (currentClaim && processIsAlive(currentClaim.pid))
            return false;
        throw abandonedRecoveryError(claimFile);
    }
    try {
        // Another normal owner may have released/reacquired while this contender
        // was obtaining the recovery claim. Only the exact observed dead owner may
        // be removed.
        const currentOwner = readOwner(lockFile);
        if (!sameOwner(currentOwner, observedOwner))
            return false;
        const age = lockAgeMs(lockFile);
        if (age === null || age <= STALE_LOCK_TIMEOUT || processIsAlive(currentOwner?.pid))
            return false;
        node_fs_1.default.unlinkSync(lockFile);
        // Normal contenders intentionally ignore the recovery claim. Atomic `wx`
        // still chooses exactly one next visible owner if one arrives in this gap.
        return createOwnerFile(lockFile, contender);
    }
    finally {
        // No successor claim can exist until this pathname is removed, so an
        // owner-checked unlink is sufficient and cannot delete another claim.
        if (ownerMatches(claimFile, claimOwner)) {
            try {
                node_fs_1.default.unlinkSync(claimFile);
            }
            catch { }
        }
    }
}
function tryAcquireVisibleLock(lockFile, owner) {
    // Fast path: one local atomic primitive and no recovery metadata.
    if (createOwnerFile(lockFile, owner))
        return true;
    const age = lockAgeMs(lockFile);
    if (age === null || age <= STALE_LOCK_TIMEOUT)
        return false;
    const observedOwner = readOwner(lockFile);
    if (!observedOwner) {
        // The stale-age stat and owner read are not one atomic observation. A
        // recovery winner can unlink the stale owner and create its successor in
        // between; `wx` makes that new pathname visible before another contender
        // is guaranteed to observe its complete tiny JSON payload. Re-stat the
        // current pathname before treating unreadable evidence as abandoned. A
        // missing or young lock is ordinary contention and must be retried, while
        // a lock that is still stale and malformed remains a fail-closed manual
        // recovery case.
        const currentAge = lockAgeMs(lockFile);
        if (currentAge === null || currentAge <= STALE_LOCK_TIMEOUT)
            return false;
        throw new Error(`Stale lock ${lockFile} has malformed owner evidence. ` +
            "Failing closed: verify no owner is running, remove the lock manually, and retry.");
    }
    // Host sleep, debugger pauses, and long event-loop stalls can make mtime old
    // while the owner is valid. Never steal from a live recorded process.
    if (processIsAlive(observedOwner.pid))
        return false;
    return recoverStaleVisibleLock(lockFile, observedOwner, owner);
}
function heartbeat(lockFile, owner) {
    if (!ownerMatches(lockFile, owner))
        return;
    try {
        const now = new Date((0, host_env_1.hostEnv)().clock.now());
        node_fs_1.default.utimesSync(lockFile, now, now);
    }
    catch {
        // Owner-checked cleanup remains authoritative.
    }
}
function releaseVisibleLock(lockFile, owner) {
    // Under the protocol, a successor cannot create the visible lock until this
    // owner unlinks it. Recovery cannot race this live process because it checks
    // PID liveness while holding the fixed recovery claim.
    if (!ownerMatches(lockFile, owner))
        return;
    try {
        node_fs_1.default.unlinkSync(lockFile);
    }
    catch { }
}
function retryDelayMs() {
    return RETRY_MIN_DELAY_MS + Math.floor((0, host_env_1.hostEnv)().random.float() * (RETRY_MAX_DELAY_MS - RETRY_MIN_DELAY_MS + 1));
}
const unboundedLockWait = new node_async_hooks_1.AsyncLocalStorage();
const lockDeadline = new node_async_hooks_1.AsyncLocalStorage();
class LockDeadlineError extends Error {
    constructor() { super("receipt_deadline_expired"); }
}
exports.LockDeadlineError = LockDeadlineError;
/** One operation deadline covers nested authority locks. Late callbacks fail before mutation. */
function withLockDeadline(deadline, action, signal) {
    return lockDeadline.run({ at: deadline, signal }, action);
}
function assertLockDeadline() {
    const deadline = lockDeadline.getStore();
    if (deadline && (deadline.signal?.aborted || (0, host_env_1.hostEnv)().clock.now() >= deadline.at))
        throw new LockDeadlineError();
}
/** Admission must not exit a live Worker due to lock contention. The launcher
 * owns its hang ceiling. Async scope also covers nested persistence locks. */
function withUnboundedLockWait(action) {
    return unboundedLockWait.run(true, action);
}
async function withLock(lockPath, fn, retries = 50) {
    const lockFile = `${lockPath}.lock`;
    const owner = { pid: (0, host_env_1.hostEnv)().process.pid, token: (0, host_env_1.hostEnv)().random.uuid() };
    const waitStartedAt = (0, host_env_1.hostEnv)().clock.now();
    // Preserve the old public retry budget (retries * 100 ms) while polling with
    // short jitter. Twenty local contenders no longer advance one per 100 ms.
    const deadline = lockDeadline.getStore()?.at;
    let waitBudgetMs = deadline !== undefined ? Math.max(0, deadline - waitStartedAt)
        : unboundedLockWait.getStore() ? Infinity : Math.max(0, retries) * LEGACY_RETRY_INTERVAL_MS;
    let acquired = false;
    if (waitBudgetMs > 0) {
        while (true) {
            assertLockDeadline();
            if (tryAcquireVisibleLock(lockFile, owner)) {
                acquired = true;
                break;
            }
            if (waitBudgetMs <= 0)
                break;
            const delay = Math.min(retryDelayMs(), waitBudgetMs, deadline === undefined ? Infinity : deadline - (0, host_env_1.hostEnv)().clock.now());
            await new Promise((resolve) => (0, host_env_1.hostEnv)().clock.setTimeout(resolve, delay));
            waitBudgetMs -= delay;
        }
    }
    (0, trace_1.recordLockWait)((0, host_env_1.hostEnv)().clock.now() - waitStartedAt);
    if (!acquired) {
        assertLockDeadline();
        throw new Error("Could not acquire lock");
    }
    const heartbeatTimer = (0, host_env_1.hostEnv)().clock.setInterval(() => heartbeat(lockFile, owner), HEARTBEAT_INTERVAL_MS);
    if ("unref" in heartbeatTimer)
        heartbeatTimer.unref();
    try {
        assertLockDeadline();
        return await fn();
    }
    finally {
        (0, host_env_1.hostEnv)().clock.clearInterval(heartbeatTimer);
        releaseVisibleLock(lockFile, owner);
    }
}
/** Acquire several locks in a stable order so a composite write cannot leave
 * one side committed merely because the other side was missing. */
async function withLocks(lockPaths, fn, retries = 50) {
    const paths = [...new Set(lockPaths)].sort();
    const acquire = async (index) => {
        if (index === paths.length)
            return fn();
        return withLock(paths[index], () => acquire(index + 1), retries);
    };
    return acquire(0);
}
