import { describe, expect, it, vi } from "vitest";
import type { TeamEventWaitResult } from "./team-events";
import type { TeamEvent } from "./models";
import { observeWorkerStartup } from "./worker-startup-observation";

function batch(cursor: string, events: TeamEvent[], timedOut = false): TeamEventWaitResult {
  return { cursor, headCursor: cursor, events, truncated: false, remaining: 0, timedOut };
}

function workerEvent(cursor: string, worker: string, membershipId: string, phase: "prepared" | "session_bound"): TeamEvent {
  return { type: "worker", cursor, worker, membershipId, phase, generation: phase === "session_bound" ? { membershipId, pid: 42, startedAt: 100 } : undefined, at: "2026-07-26T00:00:00.000Z" };
}

const base = {
  teamName: "dogfood",
  workerName: "reviewer",
  membershipId: "membership-reviewer",
  afterCursor: "1",
};

describe("bounded Worker startup observation", () => {
  it("accepts the exact Membership binding only after durable authority verifies it", async () => {
    const waitForEvents = vi.fn(async () => batch("2", [workerEvent("2", "reviewer", "membership-reviewer", "session_bound")]));
    const result = await observeWorkerStartup({
      ...base,
      timeoutMs: 3_000,
      waitForEvents,
      verifyAuthority: async () => ({ sessionBound: true, generation: { membershipId: "membership-reviewer", pid: 42, startedAt: 100 } }),
    });

    expect(result).toEqual({ observed: true, carrier: "session_bound", runtime: "observed", cursor: "2" });
    expect(waitForEvents).toHaveBeenCalledWith(expect.objectContaining({
      afterCursor: "1",
      eventTypes: ["worker"],
      waitMs: expect.any(Number),
    }));
  });

  it("advances past unrelated Worker events and waits within one deadline", async () => {
    let time = 1_000;
    const waitForEvents = vi.fn()
      .mockImplementationOnce(async () => {
        time = 1_400;
        return batch("2", [workerEvent("2", "other", "membership-other", "session_bound")]);
      })
      .mockImplementationOnce(async () => batch("3", [workerEvent("3", "reviewer", "membership-reviewer", "session_bound")]));

    const result = await observeWorkerStartup({
      ...base,
      timeoutMs: 3_000,
      now: () => time,
      waitForEvents,
      verifyAuthority: async () => ({ sessionBound: true, generation: { membershipId: "membership-reviewer", pid: 42, startedAt: 100 } }),
    });

    expect(result.observed).toBe(true);
    expect(waitForEvents).toHaveBeenNthCalledWith(2, expect.objectContaining({ afterCursor: "2", waitMs: 2_600 }));
  });

  it("returns the verified carrier state when the deadline expires", async () => {
    const result = await observeWorkerStartup({
      ...base,
      timeoutMs: 0,
      waitForEvents: async () => batch("1", [], true),
      verifyAuthority: async () => ({ sessionBound: false }),
    });
    expect(result).toEqual({
      observed: false,
      carrier: "prepared",
      runtime: "not_observed",
      cursor: "1",
      reason: "timeout",
    });
  });

  it("refuses to infer runtime observation from an event when exact authority mismatches", async () => {
    const result = await observeWorkerStartup({
      ...base,
      waitForEvents: async () => batch("2", [workerEvent("2", "reviewer", "membership-reviewer", "session_bound")]),
      verifyAuthority: async () => ({ sessionBound: true }),
    });
    expect(result).toMatchObject({ observed: false, carrier: "session_bound", reason: "timeout" });
  });

  it("retries authority visibility at bounded cadence until the exact tuple appears", async () => {
    let now = 0; let checks = 0;
    const waitForRetry = vi.fn(async () => { now += 50; });
    const result = await observeWorkerStartup({
      ...base, timeoutMs: 150, now: () => now, waitForRetry,
      waitForEvents: async () => batch("2", [workerEvent("2", "reviewer", "membership-reviewer", "session_bound")]),
      verifyAuthority: async () => (++checks < 3 ? { sessionBound: true, generation: { membershipId: "membership-reviewer", pid: 42, startedAt: 99 } } : { sessionBound: true, generation: { membershipId: "membership-reviewer", pid: 42, startedAt: 100 } }),
    });
    expect(result.observed).toBe(true); expect(waitForRetry).toHaveBeenCalledTimes(2); expect(checks).toBe(3);
  });

  it("zero deadline checks exact authority once and legacy events cannot prove startup", async () => {
    const exact = await observeWorkerStartup({ ...base, timeoutMs: 0, waitForEvents: async () => batch("2", [workerEvent("2", "reviewer", "membership-reviewer", "session_bound")]), verifyAuthority: async () => ({ sessionBound: true, generation: { membershipId: "membership-reviewer", pid: 42, startedAt: 100 } }) });
    expect(exact.observed).toBe(true);
    const legacy = workerEvent("2", "reviewer", "membership-reviewer", "session_bound") as any; delete legacy.generation;
    const old = await observeWorkerStartup({ ...base, timeoutMs: 0, waitForEvents: async () => batch("2", [legacy], true), verifyAuthority: async () => ({ sessionBound: true, generation: { membershipId: "membership-reviewer", pid: 42, startedAt: 100 } }) });
    expect(old).toMatchObject({ observed: false, reason: "timeout" });
  });

  it("rejects wrong pid then wrong startedAt through the cadence deadline", async () => {
    let now = 0; let checks = 0; const waits: number[] = [];
    const result = await observeWorkerStartup({ ...base, timeoutMs: 100, now: () => now,
      waitForEvents: async () => batch("2", [workerEvent("2", "reviewer", "membership-reviewer", "session_bound")]),
      waitForRetry: async (ms) => { waits.push(ms); now += ms; },
      verifyAuthority: async () => (++checks === 1 ? { sessionBound: true, generation: { membershipId: "membership-reviewer", pid: 99, startedAt: 100 } } : { sessionBound: true, generation: { membershipId: "membership-reviewer", pid: 42, startedAt: 99 } }),
    });
    expect(result).toMatchObject({ observed: false, reason: "timeout" }); expect(checks).toBe(3); expect(waits.every((ms) => ms <= 50)).toBe(true);
  });

  it("propagates AbortError from post-event cadence", async () => {
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(observeWorkerStartup({ ...base, waitForEvents: async () => batch("2", [workerEvent("2", "reviewer", "membership-reviewer", "session_bound")]), verifyAuthority: async () => ({ sessionBound: false }), waitForRetry: async () => { throw aborted; } })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("zero deadline wrong tuple checks authority once", async () => {
    const verifyAuthority = vi.fn(async () => ({ sessionBound: true, generation: { membershipId: "membership-reviewer", pid: 99, startedAt: 100 } }));
    const result = await observeWorkerStartup({ ...base, timeoutMs: 0, waitForEvents: async () => batch("2", [workerEvent("2", "reviewer", "membership-reviewer", "session_bound")]), verifyAuthority });
    expect(result).toMatchObject({ observed: false, reason: "timeout" }); expect(verifyAuthority).toHaveBeenCalledOnce();
  });

  it("propagates cancellation instead of converting it to a timeout", async () => {
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(observeWorkerStartup({
      ...base,
      waitForEvents: async () => { throw aborted; },
      verifyAuthority: async () => ({ sessionBound: false }),
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
