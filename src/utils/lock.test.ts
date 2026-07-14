// Project: pi-teams
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { withLock } from "./lock";

describe("withLock", () => {
  const testDir = path.join(os.tmpdir(), "pi-lock-test-" + Date.now());
  const lockPath = path.join(testDir, "test");
  const lockFile = `${lockPath}.lock`;

  beforeEach(() => {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("should successfully acquire and release the lock", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const result = await withLock(lockPath, fn);

    expect(result).toBe("result");
    expect(fn).toHaveBeenCalled();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("should fail to acquire lock if already held", async () => {
    // Manually create lock file
    fs.writeFileSync(lockFile, "9999");

    const fn = vi.fn().mockResolvedValue("result");
    
    // Test with only 2 retries to speed up the failure
    await expect(withLock(lockPath, fn, 2)).rejects.toThrow("Could not acquire lock");
    expect(fn).not.toHaveBeenCalled();
  });

  it("should release lock even if function fails", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("failure"));

    await expect(withLock(lockPath, fn)).rejects.toThrow("failure");
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("does not steal an old-looking lock while its recorded process is alive", async () => {
    let releaseOwner!: () => void;
    const ownerMayExit = new Promise<void>((resolve) => { releaseOwner = resolve; });
    let ownerEntered!: () => void;
    const ownerDidEnter = new Promise<void>((resolve) => { ownerEntered = resolve; });

    const first = withLock(lockPath, async () => {
      ownerEntered();
      await ownerMayExit;
    });
    await ownerDidEnter;

    const staleTime = new Date(Date.now() - 31_000);
    fs.utimesSync(lockFile, staleTime, staleTime);

    const contender = vi.fn().mockResolvedValue(undefined);
    await expect(withLock(lockPath, contender, 2)).rejects.toThrow("Could not acquire lock");
    expect(contender).not.toHaveBeenCalled();

    releaseOwner();
    await first;
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("does not let a former owner delete a successor's lock", async () => {
    let releaseOwner!: () => void;
    const ownerMayExit = new Promise<void>((resolve) => { releaseOwner = resolve; });
    let ownerEntered!: () => void;
    const ownerDidEnter = new Promise<void>((resolve) => { ownerEntered = resolve; });

    const first = withLock(lockPath, async () => {
      ownerEntered();
      await ownerMayExit;
    });
    await ownerDidEnter;

    const successor = { pid: process.pid, token: "successor-token" };
    fs.writeFileSync(lockFile, JSON.stringify(successor));

    releaseOwner();
    await first;

    expect(JSON.parse(fs.readFileSync(lockFile, "utf8"))).toEqual(successor);
  });

  it("recovers a stale legacy lock after its process is dead", async () => {
    fs.writeFileSync(lockFile, "2147483647");
    const staleTime = new Date(Date.now() - 31_000);
    fs.utimesSync(lockFile, staleTime, staleTime);

    const fn = vi.fn().mockResolvedValue("recovered");
    await expect(withLock(lockPath, fn, 2)).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledOnce();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("fails closed with manual recovery instructions when a recovery claimer died", async () => {
    const claimFile = `${lockFile}.recovery`;
    fs.writeFileSync(lockFile, "2147483647");
    const staleTime = new Date(Date.now() - 31_000);
    fs.utimesSync(lockFile, staleTime, staleTime);
    fs.writeFileSync(claimFile, JSON.stringify({ pid: 2147483647, token: "dead-recovery" }));
    fs.utimesSync(claimFile, staleTime, staleTime);

    await expect(withLock(lockPath, async () => "must-not-enter", 2))
      .rejects.toThrow(/recovery claim.*abandoned.*manually/i);
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(fs.existsSync(claimFile)).toBe(true);
  });
});
