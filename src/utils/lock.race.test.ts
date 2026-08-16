import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { withLock } from "./lock";

describe("withLock race conditions", () => {
  const testDir = path.join(os.tmpdir(), "pi-lock-race-test-" + Date.now());
  const lockPath = path.join(testDir, "test");
  const lockFile = `${lockPath}.lock`;

  beforeEach(() => {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("retries when a stale observation races a young successor owner write", async () => {
    fs.writeFileSync(lockFile, "2147483647");
    const staleTime = new Date(Date.now() - 31_000);
    fs.utimesSync(lockFile, staleTime, staleTime);

    const originalReadFileSync = fs.readFileSync.bind(fs);
    const successor = { pid: process.pid, token: "replacement-owner" };
    let injectedReplacement = false;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
      if (!injectedReplacement && path.resolve(String(file)) === path.resolve(lockFile)) {
        injectedReplacement = true;
        // Deterministically reproduce: contender A observed the stale mtime,
        // contender B replaced it, then A observed B's pathname before its
        // owner payload was readable. The actual file contains B's completed
        // payload so the microtask can release only that exact successor.
        fs.unlinkSync(lockFile);
        fs.writeFileSync(lockFile, JSON.stringify(successor), { mode: 0o600 });
        queueMicrotask(() => {
          try {
            const current = JSON.parse(originalReadFileSync(lockFile, "utf8"));
            if (current.pid === successor.pid && current.token === successor.token) {
              fs.unlinkSync(lockFile);
            }
          } catch {}
        });
        return "";
      }
      return originalReadFileSync(file, ...args);
    }) as typeof fs.readFileSync);

    const criticalSection = vi.fn().mockResolvedValue("acquired-after-retry");
    await expect(withLock(lockPath, criticalSection, 2)).resolves.toBe("acquired-after-retry");
    expect(injectedReplacement).toBe(true);
    expect(criticalSection).toHaveBeenCalledOnce();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("retries when a competing recovery claim disappears before inspection", async () => {
    fs.writeFileSync(lockFile, "2147483647");
    const staleTime = new Date(Date.now() - 31_000);
    fs.utimesSync(lockFile, staleTime, staleTime);

    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    const claimFile = `${lockFile}.recovery`;
    let injectedDeparture = false;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file: any, data: any, ...args: any[]) => {
      if (!injectedDeparture && path.resolve(String(file)) === path.resolve(claimFile)) {
        injectedDeparture = true;
        // A failed exclusive create proves another claimer existed, but that
        // claimer can finish and remove its fixed claim before this contender
        // observes the pathname. That is ordinary contention, not abandonment.
        originalWriteFileSync(file, data, ...args);
        fs.unlinkSync(claimFile);
        throw Object.assign(new Error("simulated competing recovery claim"), { code: "EEXIST" });
      }
      return originalWriteFileSync(file, data, ...args);
    }) as typeof fs.writeFileSync);

    const criticalSection = vi.fn().mockResolvedValue("acquired-after-retry");
    await expect(withLock(lockPath, criticalSection, 2)).resolves.toBe("acquired-after-retry");
    expect(injectedDeparture).toBe(true);
    expect(criticalSection).toHaveBeenCalledOnce();
    expect(fs.existsSync(claimFile)).toBe(false);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("still fails closed when malformed owner evidence remains stale", async () => {
    fs.writeFileSync(lockFile, "malformed-owner");
    const staleTime = new Date(Date.now() - 31_000);
    fs.utimesSync(lockFile, staleTime, staleTime);

    await expect(withLock(lockPath, async () => "must-not-enter", 2))
      .rejects.toThrow(/stale lock.*malformed owner evidence.*failing closed/i);
    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it("should handle multiple concurrent attempts to acquire the lock", async () => {
    let counter = 0;
    const iterations = 20;
    const concurrentCount = 5;

    const runTask = async () => {
      for (let i = 0; i < iterations; i++) {
        await withLock(lockPath, async () => {
          const current = counter;
          // Yield at the read/write boundary so a missing lock deterministically
          // loses increments, without adding random timing to the oracle.
          await Promise.resolve();
          counter = current + 1;
        });
      }
    };

    const promises = [];
    for (let i = 0; i < concurrentCount; i++) {
      promises.push(runTask());
    }

    await Promise.all(promises);

    expect(counter).toBe(iterations * concurrentCount);
  });

  it("uses short retries under 20-way local contention while preserving mutual exclusion", async () => {
    type Release = () => void;
    const retryDelays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: any[]) => void,
      delay?: number,
      ...args: any[]
    ) => {
      if (typeof delay === "number") retryDelays.push(delay);
      return realSetTimeout(callback, delay, ...args);
    }) as typeof globalThis.setTimeout);

    const pendingEntries: Release[] = [];
    const entryWaiters: Array<(release: Release) => void> = [];
    const waitForEntry = (): Promise<Release> => new Promise((resolve) => {
      const pending = pendingEntries.shift();
      if (pending) resolve(pending);
      else entryWaiters.push(resolve);
    });

    let active = 0;
    let maxActive = 0;
    const criticalSection = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      let release!: Release;
      const mayExit = new Promise<void>((resolve) => { release = resolve; });
      const waiter = entryWaiters.shift();
      if (waiter) waiter(release);
      else pendingEntries.push(release);
      await mayExit;
      active -= 1;
    };

    // Hold the first owner until all contenders have attempted acquisition.
    // Each contender must schedule one retry while the lock is unavailable.
    const firstOwner = withLock(lockPath, criticalSection);
    const releaseFirstOwner = await waitForEntry();
    const contenders = Array.from({ length: 19 }, () => withLock(lockPath, criticalSection));
    const initialRetryDelays = [...retryDelays];

    releaseFirstOwner();
    for (let index = 0; index < contenders.length; index++) {
      const release = await waitForEntry();
      release();
    }
    await Promise.all([firstOwner, ...contenders]);

    expect(maxActive).toBe(1);
    expect(initialRetryDelays).toHaveLength(19);
    expect(retryDelays.length).toBeGreaterThanOrEqual(19);
    expect(retryDelays.every((delay) => delay >= 5 && delay <= 15)).toBe(true);
    expect(retryDelays).not.toContain(100);
  });

  it("allows exactly one stale-lock takeover at a time across 20 processes", async () => {
    const workerFile = path.join(testDir, "stale-worker.cjs");
    const resolveFromTest = createRequire(path.join(process.cwd(), "package.json"));
    const startFile = path.join(testDir, "start");
    const eventsFile = path.join(testDir, "events.jsonl");
    const source = path.resolve(process.cwd(), "src/utils/lock.ts");
    fs.writeFileSync(workerFile, `
require(${JSON.stringify(resolveFromTest.resolve("ts-node/register/transpile-only"))});
const fs = require("node:fs");
const { withLock } = require(${JSON.stringify(source)});
const [lockPath, startFile, eventsFile, id] = process.argv.slice(2);
async function main() {
  while (!fs.existsSync(startFile)) await new Promise((resolve) => setTimeout(resolve, 1));
  await withLock(lockPath, async () => {
    fs.appendFileSync(eventsFile, JSON.stringify({ kind: "enter", id, at: Date.now() }) + "\\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.appendFileSync(eventsFile, JSON.stringify({ kind: "exit", id, at: Date.now() }) + "\\n");
  }, 200);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`);

    fs.writeFileSync(lockFile, "2147483647");
    const staleTime = new Date(Date.now() - 31_000);
    fs.utimesSync(lockFile, staleTime, staleTime);

    const children = Array.from({ length: 20 }, (_, index) => spawn(
      process.execPath,
      [workerFile, lockPath, startFile, eventsFile, String(index)],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
    ));
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.writeFileSync(startFile, "go");

    const results = await Promise.all(children.map((child) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = "";
      child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("close", (code) => resolve({ code, stderr }));
    })));
    expect(results).toEqual(Array.from({ length: 20 }, () => ({ code: 0, stderr: "" })));

    const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      kind: "enter" | "exit";
      id: string;
      at: number;
    });
    expect(events).toHaveLength(40);
    const intervals = new Map<string, { enter?: number; exit?: number }>();
    for (const event of events) {
      const interval = intervals.get(event.id) || {};
      interval[event.kind] = event.at;
      intervals.set(event.id, interval);
    }
    expect(intervals.size).toBe(20);
    const complete = [...intervals.values()] as Array<{ enter: number; exit: number }>;
    for (let left = 0; left < complete.length; left++) {
      expect(complete[left].enter).toBeLessThanOrEqual(complete[left].exit);
      for (let right = left + 1; right < complete.length; right++) {
        const overlaps = complete[left].enter < complete[right].exit && complete[right].enter < complete[left].exit;
        expect(overlaps).toBe(false);
      }
    }
    expect(fs.existsSync(`${lockFile}.recovery`)).toBe(false);
    expect(fs.existsSync(lockFile)).toBe(false);
  }, 30_000);
});
