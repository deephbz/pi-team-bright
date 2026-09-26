import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SyncNudgeConductor, type SyncNudgeDebt } from "./sync-nudge-conductor";

class FakeClock {
  now = 0;
  next = 1;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.next++;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  };
  clearTimeout = (handle: unknown) => { this.timers.delete(handle as number); };
  async advance(ms: number): Promise<void> {
    this.now += ms;
    for (const [id, timer] of [...this.timers].filter(([, timer]) => timer.at <= this.now)) {
      this.timers.delete(id);
      timer.callback();
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function debt(overrides: Partial<Extract<SyncNudgeDebt, { kind: "eligible" }>> = {}): Extract<SyncNudgeDebt, { kind: "eligible" }> {
  return {
    kind: "eligible", debtKey: "content-1", scopeKey: "baseline-1", updateCount: 1,
    requestedView: "updates", teamEpochId: "epoch-1", leaderSessionId: "leader-1",
    leaderMembershipId: "membership-1", branchLineage: ["root-1", "branch-1"],
    branchId: "branch-1", policyVersion: "2", ...overrides,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("automatic Team sync conductor", () => {
  it("publishes at the count threshold before the maximum delay", async () => {
    const clock = new FakeClock();
    let current: SyncNudgeDebt = debt();
    const published: string[] = [];
    let delivered = false;
    const conductor = new SyncNudgeConductor({
      clock, delayMs: 5_000, updateThreshold: 3, readDebt: async () => current,
      isSettled: () => true, isBusy: () => false, alreadyPresented: () => delivered,
      present: async (value) => { published.push(value.debtKey); delivered = true; return true; },
    });
    conductor.start(); await conductor.reconcile();
    current = debt({ debtKey: "content-2", updateCount: 2 });
    conductor.notify(); await conductor.reconcile();
    expect(published).toEqual([]);
    current = debt({ debtKey: "content-3", updateCount: 3 });
    conductor.notify(); await conductor.reconcile();
    expect(published).toEqual(["content-3"]);
    expect(clock.now).toBe(0);
  });

  it("schedules a bounded continuation page by deadline without counting lookahead", async () => {
    const clock = new FakeClock();
    const published: number[] = [];
    const conductor = new SyncNudgeConductor({
      clock, delayMs: 5, updateThreshold: 1,
      readDebt: async () => debt({ updateCount: 0 }),
      isSettled: () => true, isBusy: () => false, alreadyPresented: () => published.length > 0,
      present: async (value) => { published.push(value.updateCount); return true; },
    });
    conductor.start(); await tick();
    expect(published).toEqual([]);
    await clock.advance(4);
    expect(published).toEqual([]);
    await clock.advance(1);
    expect(published).toEqual([0]);
  });

  it("keeps the first deadline when content changes within one scope", async () => {
    const clock = new FakeClock();
    let current: SyncNudgeDebt = debt();
    const published: string[] = [];
    const conductor = new SyncNudgeConductor({
      clock, delayMs: 5_000, updateThreshold: 10, readDebt: async () => current,
      isSettled: () => true, isBusy: () => false, alreadyPresented: () => false,
      present: async (value) => { published.push(value.debtKey); return true; },
    });
    conductor.start(); await conductor.reconcile();
    const deadline = [...clock.timers.values()][0].at;
    await clock.advance(4_000);
    current = debt({ debtKey: "content-2", updateCount: 2 });
    conductor.notify(); await conductor.reconcile();
    expect([...clock.timers.values()][0].at).toBe(deadline);
    await clock.advance(1_000);
    expect(published).toEqual(["content-2"]);
  });

  it("retains an expired deadline while busy and publishes after settle", async () => {
    const clock = new FakeClock(); let busy = false;
    const published: string[] = [];
    const conductor = new SyncNudgeConductor({
      clock, delayMs: 5, updateThreshold: 10, readDebt: async () => debt(),
      isSettled: () => true, isBusy: () => busy, alreadyPresented: () => false,
      present: async (value) => { published.push(value.debtKey); return true; },
    });
    conductor.start(); await conductor.reconcile();
    busy = true;
    await clock.advance(5);
    expect(published).toEqual([]);
    busy = false;
    conductor.notify(); await conductor.reconcile();
    expect(published).toEqual(["content-1"]);
  });

  it("does not mark a skipped or failed publish as delivered", async () => {
    const clock = new FakeClock(); let attempts = 0; let delivered = false;
    const conductor = new SyncNudgeConductor({
      clock, delayMs: 0, updateThreshold: 1, readDebt: async () => debt(),
      isSettled: () => true, isBusy: () => false, alreadyPresented: () => delivered,
      present: async () => { attempts++; delivered = attempts > 1; return delivered; },
    });
    conductor.start(); await tick();
    expect(attempts).toBe(1);
    conductor.notify(); await tick();
    expect(attempts).toBe(2);
    conductor.notify(); await tick();
    expect(attempts).toBe(2);
  });

  it("rechecks a notify that arrives while a debt read is in flight", async () => {
    const clock = new FakeClock();
    let release!: (value: SyncNudgeDebt) => void;
    let reads = 0;
    const published: string[] = [];
    let delivered = false;
    const conductor = new SyncNudgeConductor({
      clock, delayMs: 5_000, updateThreshold: 2,
      readDebt: () => ++reads === 1
        ? new Promise<SyncNudgeDebt>((resolve) => { release = resolve; })
        : Promise.resolve(debt({ debtKey: "content-2", updateCount: 2 })),
      isSettled: () => true, isBusy: () => false, alreadyPresented: () => delivered,
      present: async (value) => { published.push(value.debtKey); delivered = true; return true; },
    });
    conductor.start();
    conductor.notify();
    release(debt());
    await conductor.reconcile();
    expect(reads).toBe(2);
    expect(published).toEqual(["content-2"]);
  });

  it("discards a read from a stopped generation", async () => {
    const clock = new FakeClock(); let release!: (value: SyncNudgeDebt) => void;
    let first = true; let published = 0;
    const conductor = new SyncNudgeConductor({
      clock, delayMs: 5, updateThreshold: 1,
      readDebt: () => first ? (first = false, new Promise<SyncNudgeDebt>((resolve) => { release = resolve; })) : Promise.resolve({ kind: "none" }),
      isSettled: () => true, isBusy: () => false, alreadyPresented: () => false,
      present: async () => { published++; return true; },
    });
    conductor.start(); conductor.stop(); conductor.start(); await conductor.reconcile();
    release(debt()); await tick(); await clock.advance(10);
    expect(published).toBe(0);
  });

  it("keeps authority and durable records outside the scheduler", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/utils/sync-nudge-conductor.ts"), "utf8");
    expect(source).toContain('import type { SyncNudgeDebt } from "../coordination/nudge-debt"');
    expect(source).not.toContain("readSyncNudgeDebt");
  });
});
