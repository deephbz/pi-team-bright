import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SyncNudgeConductor, type SyncNudgeDebt } from "./sync-nudge-conductor";

class FakeClock {
  now = 0;
  next = 1;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout = (callback: () => void, delayMs: number) => { const id = this.next++; this.timers.set(id, { at: this.now + delayMs, callback }); return id; };
  clearTimeout = (handle: unknown) => { this.timers.delete(handle as number); };
  async advance(ms: number): Promise<void> {
    this.now += ms;
    const due = [...this.timers].filter(([, timer]) => timer.at <= this.now);
    for (const [id, timer] of due) { this.timers.delete(id); timer.callback(); }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function debt(overrides: Partial<Extract<SyncNudgeDebt, { kind: "eligible" }>> = {}): Extract<SyncNudgeDebt, { kind: "eligible" }> {
  return { kind: "eligible", debtKey: "debt-1", requestedView: "updates", teamEpochId: "epoch-1", leaderSessionId: "leader-1", leaderMembershipId: "membership-1", branchLineage: ["root-1", "branch-1"], branchId: "branch-1", policyVersion: "1", ...overrides };
}

describe("delayed sync nudge conductor", () => {
  it("arms after a later post-settle producer hint", async () => {
    const clock = new FakeClock(); let settled = false; let current: SyncNudgeDebt = { kind: "none" }; const sent: string[] = [];
    const conductor = new SyncNudgeConductor({ clock, delayMs: 10, readDebt: async () => current, isSettled: () => settled, isBusy: () => false, alreadyPresented: () => false, present: async (value) => { sent.push(value.debtKey); } });
    conductor.start(); await conductor.reconcile(); current = debt(); conductor.notify(); await conductor.reconcile(); await clock.advance(9); expect(sent).toEqual([]); settled = true; conductor.notify(); await conductor.reconcile(); await clock.advance(10); expect(sent).toEqual(["debt-1"]);
  });

  it("reconciles an eventless Task revision hint after the leader already settled", async () => {
    const clock = new FakeClock(); let current = debt({ debtKey: "revision-1" }); const sent: string[] = [];
    const conductor = new SyncNudgeConductor({ clock, delayMs: 5, readDebt: async () => current, isSettled: () => true, isBusy: () => false, alreadyPresented: () => false, present: async (value) => { sent.push(value.debtKey); } });
    conductor.start(); await conductor.reconcile(); await clock.advance(5); expect(sent).toEqual(["revision-1"]);
    current = debt({ debtKey: "revision-2" }); conductor.notify(); await conductor.reconcile(); await clock.advance(5); expect(sent).toEqual(["revision-1", "revision-2"]);
  });

  it("suppresses an eventless revision with unknowable actor provenance", async () => {
    const clock = new FakeClock(); let sent = 0;
    const conductor = new SyncNudgeConductor({ clock, delayMs: 5, readDebt: async () => ({ kind: "indeterminate", message: "unknown actor" }), isSettled: () => true, isBusy: () => false, alreadyPresented: () => false, present: async () => { sent++; } });
    conductor.start(); await conductor.reconcile(); await clock.advance(10); expect(sent).toBe(0);
  });

  it("revalidates debt and suppresses duplicate records after restart", async () => {
    const clock = new FakeClock(); let presented = false; let sent = 0; const source = debt();
    const dependencies = { clock, delayMs: 5, readDebt: async () => source, isSettled: () => true, isBusy: () => false, alreadyPresented: () => presented, present: async () => { sent++; presented = true; } };
    const first = new SyncNudgeConductor(dependencies); first.start(); await first.reconcile(); await clock.advance(5); expect(sent).toBe(1);
    first.stop(); const second = new SyncNudgeConductor(dependencies); second.start(); await clock.advance(5); expect(sent).toBe(1);
  });

  it("does not arm a stale async read after stop and restart", async () => {
    const clock = new FakeClock();
    let reads = 0;
    let release!: (value: SyncNudgeDebt) => void;
    let sent = 0;
    const conductor = new SyncNudgeConductor({
      clock,
      delayMs: 5,
      readDebt: () => {
        reads++;
        if (reads === 1) return new Promise<SyncNudgeDebt>((resolve) => { release = resolve; });
        return Promise.resolve({ kind: "none" });
      },
      isSettled: () => true,
      isBusy: () => false,
      alreadyPresented: () => false,
      present: async () => { sent++; },
    });
    conductor.start();
    conductor.stop();
    conductor.start();
    await conductor.reconcile();
    release(debt());
    await new Promise((resolve) => setImmediate(resolve));
    await clock.advance(10);
    expect(sent).toBe(0);
    expect(clock.timers.size).toBe(0);
  });

  it("suppresses while busy and supports a snapshot request without a baseline", async () => {
    const clock = new FakeClock(); let busy = true; const sent: string[] = [];
    const conductor = new SyncNudgeConductor({ clock, delayMs: 5, readDebt: async () => debt({ requestedView: "snapshot" }), isSettled: () => true, isBusy: () => busy, alreadyPresented: () => false, present: async (value) => { sent.push(value.requestedView); } });
    conductor.start(); await conductor.reconcile(); await clock.advance(10); expect(sent).toEqual([]); busy = false; conductor.notify(); await conductor.reconcile(); await clock.advance(5); expect(sent).toEqual(["snapshot"]);
  });

  it("keeps the timer conductor free of Coordination and durable-record imports", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/utils/sync-nudge-conductor.ts"), "utf8");
    expect(source).toMatch(/import type \{ SyncNudgeDebt \} from "\.\.\/coordination\/nudge-debt"/);
    expect(source).not.toMatch(/from ["'][^"']*(?:sync-nudge|durable-model-tool-port|team-events)[^"']*["']/);
    expect(source).not.toContain("readSyncNudgeDebt");
    expect(source).toContain("readDebt: () => Promise<SyncNudgeDebt>");
  });
});
