// Project: pi-teams
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recordLockWait } from "./trace";

const LEGACY_RETRY_INTERVAL_MS = 100;
const RETRY_MIN_DELAY_MS = 5;
const RETRY_MAX_DELAY_MS = 15;
const STALE_LOCK_TIMEOUT = 30_000;
const HEARTBEAT_INTERVAL_MS = Math.floor(STALE_LOCK_TIMEOUT / 3);

interface LockOwner {
  pid: number;
  token: string;
}

function ownerText(owner: LockOwner): string {
  return JSON.stringify(owner);
}

function sameOwner(left: LockOwner | null, right: LockOwner): boolean {
  return left?.pid === right.pid && left.token === right.token;
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner> | number;
    if (
      typeof parsed === "object"
      && parsed !== null
      && Number.isSafeInteger(parsed.pid)
      && (parsed.pid as number) > 0
      && typeof parsed.token === "string"
      && parsed.token.length > 0
    ) {
      return { pid: parsed.pid as number, token: parsed.token };
    }
  } catch {}
  // Previous releases wrote only the PID. JSON.parse accepts a numeric PID,
  // so this fallback must run after both successful and failed JSON parsing.
  const legacyPid = Number(raw.trim());
  if (Number.isSafeInteger(legacyPid) && legacyPid > 0) {
    return { pid: legacyPid, token: "legacy" };
  }
  return null;
}

function readOwner(file: string): LockOwner | null {
  try {
    return parseOwner(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function ownerMatches(file: string, owner: LockOwner): boolean {
  return sameOwner(readOwner(file), owner);
}

function processIsAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function createOwnerFile(file: string, owner: LockOwner): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ownerText(owner), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error: any) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

function lockAgeMs(file: string): number | null {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function abandonedRecoveryError(claimFile: string): Error {
  return new Error(
    `Lock recovery claim ${claimFile} is abandoned or malformed. ` +
    "Failing closed: verify that no recovery process is running, then remove this claim manually and retry.",
  );
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
function recoverStaleVisibleLock(lockFile: string, observedOwner: LockOwner, contender: LockOwner): boolean {
  const claimFile = `${lockFile}.recovery`;
  const claimOwner: LockOwner = { pid: process.pid, token: crypto.randomUUID() };

  if (!createOwnerFile(claimFile, claimOwner)) {
    const claimAge = lockAgeMs(claimFile);
    const currentClaim = readOwner(claimFile);
    // `wx` makes the pathname visible before another process is guaranteed to
    // observe the complete tiny JSON payload. A young unreadable claim is an
    // in-progress acquisition, not abandoned evidence.
    if (claimAge !== null && claimAge <= STALE_LOCK_TIMEOUT) return false;
    if (currentClaim && processIsAlive(currentClaim.pid)) return false;
    throw abandonedRecoveryError(claimFile);
  }

  try {
    // Another normal owner may have released/reacquired while this contender
    // was obtaining the recovery claim. Only the exact observed dead owner may
    // be removed.
    const currentOwner = readOwner(lockFile);
    if (!sameOwner(currentOwner, observedOwner)) return false;
    const age = lockAgeMs(lockFile);
    if (age === null || age <= STALE_LOCK_TIMEOUT || processIsAlive(currentOwner?.pid)) return false;

    fs.unlinkSync(lockFile);
    // Normal contenders intentionally ignore the recovery claim. Atomic `wx`
    // still chooses exactly one next visible owner if one arrives in this gap.
    return createOwnerFile(lockFile, contender);
  } finally {
    // No successor claim can exist until this pathname is removed, so an
    // owner-checked unlink is sufficient and cannot delete another claim.
    if (ownerMatches(claimFile, claimOwner)) {
      try { fs.unlinkSync(claimFile); } catch {}
    }
  }
}

function tryAcquireVisibleLock(lockFile: string, owner: LockOwner): boolean {
  // Fast path: one local atomic primitive and no recovery metadata.
  if (createOwnerFile(lockFile, owner)) return true;

  const age = lockAgeMs(lockFile);
  if (age === null || age <= STALE_LOCK_TIMEOUT) return false;
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
    if (currentAge === null || currentAge <= STALE_LOCK_TIMEOUT) return false;
    throw new Error(
      `Stale lock ${lockFile} has malformed owner evidence. ` +
      "Failing closed: verify no owner is running, remove the lock manually, and retry.",
    );
  }
  // Host sleep, debugger pauses, and long event-loop stalls can make mtime old
  // while the owner is valid. Never steal from a live recorded process.
  if (processIsAlive(observedOwner.pid)) return false;
  return recoverStaleVisibleLock(lockFile, observedOwner, owner);
}

function heartbeat(lockFile: string, owner: LockOwner): void {
  if (!ownerMatches(lockFile, owner)) return;
  try {
    const now = new Date();
    fs.utimesSync(lockFile, now, now);
  } catch {
    // Owner-checked cleanup remains authoritative.
  }
}

function releaseVisibleLock(lockFile: string, owner: LockOwner): void {
  // Under the protocol, a successor cannot create the visible lock until this
  // owner unlinks it. Recovery cannot race this live process because it checks
  // PID liveness while holding the fixed recovery claim.
  if (!ownerMatches(lockFile, owner)) return;
  try { fs.unlinkSync(lockFile); } catch {}
}

function retryDelayMs(): number {
  return RETRY_MIN_DELAY_MS + Math.floor(Math.random() * (RETRY_MAX_DELAY_MS - RETRY_MIN_DELAY_MS + 1));
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T>, retries: number = 50): Promise<T> {
  const lockFile = `${lockPath}.lock`;
  const owner: LockOwner = { pid: process.pid, token: crypto.randomUUID() };
  const waitStartedAt = Date.now();
  // Preserve the old public retry budget (retries * 100 ms) while polling with
  // short jitter. Twenty local contenders no longer advance one per 100 ms.
  let waitBudgetMs = Math.max(0, retries) * LEGACY_RETRY_INTERVAL_MS;
  let acquired = false;

  if (retries > 0) {
    while (true) {
      if (tryAcquireVisibleLock(lockFile, owner)) {
        acquired = true;
        break;
      }
      if (waitBudgetMs <= 0) break;
      const delay = Math.min(retryDelayMs(), waitBudgetMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
      waitBudgetMs -= delay;
    }
  }

  recordLockWait(Date.now() - waitStartedAt);
  if (!acquired) throw new Error("Could not acquire lock");

  const heartbeatTimer = setInterval(() => heartbeat(lockFile, owner), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeatTimer);
    releaseVisibleLock(lockFile, owner);
  }
}

/** Acquire several locks in a stable order so a composite write cannot leave
 * one side committed merely because the other side was missing. */
export async function withLocks<T>(lockPaths: string[], fn: () => Promise<T>, retries: number = 50): Promise<T> {
  const paths = [...new Set(lockPaths)].sort();
  const acquire = async (index: number): Promise<T> => {
    if (index === paths.length) return fn();
    return withLock(paths[index], () => acquire(index + 1), retries);
  };
  return acquire(0);
}
