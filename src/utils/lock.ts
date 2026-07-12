// Project: pi-teams
import fs from "node:fs";
import path from "node:path";

const LOCK_TIMEOUT = 5000; // 5 seconds of retrying
const STALE_LOCK_TIMEOUT = 30000; // 30 seconds for a lock to be considered stale

export async function withLock<T>(lockPath: string, fn: () => Promise<T>, retries: number = 50): Promise<T> {
  const lockFile = `${lockPath}.lock`;
  
  while (retries > 0) {
    try {
      // Check if lock exists and is stale
      if (fs.existsSync(lockFile)) {
        const stats = fs.statSync(lockFile);
        const age = Date.now() - stats.mtimeMs;
        if (age > STALE_LOCK_TIMEOUT) {
          // Attempt to remove stale lock
          try {
            fs.unlinkSync(lockFile);
          } catch (e) {
            // ignore, another process might have already removed it
          }
        }
      }
      
      fs.writeFileSync(lockFile, process.pid.toString(), { flag: "wx" });
      break;
    } catch (e) {
      retries--;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  if (retries === 0) {
    throw new Error("Could not acquire lock");
  }

  // Long migrations and slow external CLI calls must not look stale while
  // this process is still alive.
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockFile, now, now);
    } catch {
      // The finally block remains the authority for cleanup.
    }
  }, Math.floor(STALE_LOCK_TIMEOUT / 3));
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try {
      fs.unlinkSync(lockFile);
    } catch (e) {
      // ignore
    }
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
