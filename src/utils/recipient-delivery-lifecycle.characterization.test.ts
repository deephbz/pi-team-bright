import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecipientDeliveryLifecycle, type RecipientDeliveryBinding, type RecipientDeliveryEngine, type RecipientDeliveryPair } from "./recipient-delivery-lifecycle";

const binding: RecipientDeliveryBinding = { teamName: "recipient-delivery", recipient: "worker", membershipId: "membership-1", sessionFile: "/sessions/worker.jsonl" };
function engine(): RecipientDeliveryEngine {
  return { start: vi.fn(async () => {}), stop: vi.fn(), observeContext: vi.fn(async () => 1), commitPresentedAfterSuccessfulTurn: vi.fn(async () => 1) };
}
function fixture() {
  const pair: RecipientDeliveryPair = { direct: engine(), task: engine() };
  const isCurrentBinding = vi.fn(async () => true), publishState = vi.fn(async () => {});
  let backgroundFailure!: (engine: "alert" | "task", error: unknown) => void;
  const lifecycle = new RecipientDeliveryLifecycle({ makePair: (_binding, failed) => { backgroundFailure = failed; return pair; }, isCurrentBinding, publishState });
  return { pair, lifecycle, isCurrentBinding, publishState, failInBackground: (name: "alert" | "task") => backgroundFailure(name, new Error("scan failed")) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("independent recipient delivery lifecycle", () => {
  it.each(["direct", "task"] as const)("keeps the other engine running after %s startup fails", async failed => {
    const fx = fixture();
    vi.mocked(fx.pair[failed].start).mockRejectedValue(new Error("start failed"));
    await fx.lifecycle.activate(binding);
    expect(fx.lifecycle.binding).toEqual(binding);
    expect(fx.pair[failed].stop).toHaveBeenCalledOnce();
    const other = failed === "direct" ? fx.pair.task : fx.pair.direct;
    expect(other.start).toHaveBeenCalledOnce();
    expect(other.stop).not.toHaveBeenCalled();
    await fx.lifecycle.observeContext([]);
    await fx.lifecycle.commitPresentedAfterSuccessfulTurn("stop");
    expect(other.observeContext).toHaveBeenCalledOnce();
    expect(other.commitPresentedAfterSuccessfulTurn).toHaveBeenCalledOnce();
    expect(fx.publishState).toHaveBeenCalledWith(binding, failed === "direct" ? "alert" : "task", expect.objectContaining({ state: "degraded", operation: "start", message: "start failed" }));
  });

  it("retries only the failed engine with capped backoff and clears degradation after recovery", async () => {
    const fx = fixture();
    vi.mocked(fx.pair.task.start).mockRejectedValue(new Error("transient"));
    await fx.lifecycle.activate(binding);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = vi.mocked(fx.pair.task.start).mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fx.pair.task.start).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(fx.pair.task.start).toHaveBeenCalledTimes(count + 1);
    }
    vi.mocked(fx.pair.task.start).mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(30000);
    expect(fx.publishState).toHaveBeenLastCalledWith(binding, "task", expect.objectContaining({ state: "running" }));
    expect(fx.pair.direct.start).toHaveBeenCalledOnce();
    expect(fx.pair.direct.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["observeContext", "commitPresentedAfterSuccessfulTurn"] as const)("isolates %s failures in both directions", async method => {
    for (const failed of ["direct", "task"] as const) {
      const fx = fixture();
      await fx.lifecycle.activate(binding);
      vi.mocked(fx.pair[failed][method]).mockRejectedValueOnce(new Error("callback failed"));
      if (method === "observeContext") await fx.lifecycle.observeContext([]);
      else await fx.lifecycle.commitPresentedAfterSuccessfulTurn("stop");
      const other = failed === "direct" ? fx.pair.task : fx.pair.direct;
      expect(other[method]).toHaveBeenCalledOnce();
      expect(other.stop).not.toHaveBeenCalled();
      expect(fx.publishState).toHaveBeenCalledWith(binding, failed === "direct" ? "alert" : "task", expect.objectContaining({ state: "degraded", operation: method === "observeContext" ? "context" : "acknowledgement" }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(fx.pair[failed].start).toHaveBeenCalledTimes(2);
      fx.lifecycle.deactivate();
    }
  });

  it("restarts an engine after a background scan failure without stopping its sibling", async () => {
    const fx = fixture();
    await fx.lifecycle.activate(binding);
    fx.failInBackground("alert");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fx.pair.direct.start).toHaveBeenCalledTimes(2);
    expect(fx.pair.task.stop).not.toHaveBeenCalled();
    expect(fx.publishState).toHaveBeenCalledWith(binding, "alert", expect.objectContaining({ state: "degraded", operation: "scan" }));
  });

  it("deactivation stops both engines and cancels retry", async () => {
    const fx = fixture();
    vi.mocked(fx.pair.task.start).mockRejectedValue(new Error("start failed"));
    await fx.lifecycle.activate(binding);
    fx.lifecycle.deactivate();
    expect(fx.lifecycle.binding).toBeUndefined();
    expect(fx.pair.direct.stop).toHaveBeenCalledOnce();
    expect(fx.pair.task.stop).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fx.pair.task.start).toHaveBeenCalledOnce();
    await fx.lifecycle.observeContext([]);
    expect(fx.pair.direct.observeContext).not.toHaveBeenCalled();
  });

  it("never restarts a failed engine after the exact binding becomes stale", async () => {
    const fx = fixture();
    vi.mocked(fx.pair.task.start).mockRejectedValue(new Error("start failed"));
    await fx.lifecycle.activate(binding);
    fx.isCurrentBinding.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fx.pair.task.start).toHaveBeenCalledOnce();
    expect(fx.pair.direct.stop).toHaveBeenCalledOnce();
    expect(fx.lifecycle.binding).toBeUndefined();
  });

  it("fences a pending start and its failure after deactivation", async () => {
    const fx = fixture();
    let reject!: (error: Error) => void;
    vi.mocked(fx.pair.task.start).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const activation = fx.lifecycle.activate(binding);
    await vi.advanceTimersByTimeAsync(0);
    expect(fx.pair.task.start).toHaveBeenCalledOnce();
    fx.lifecycle.deactivate();
    reject(new Error("late start failure"));
    await activation;
    expect(fx.lifecycle.binding).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(fx.publishState.mock.calls.some(call => (call as any[])[2].state === "degraded")).toBe(false);
  });

  it("stops both engines even if one cleanup throws", async () => {
    const fx = fixture();
    await fx.lifecycle.activate(binding);
    vi.mocked(fx.pair.direct.stop).mockImplementation(() => { throw new Error("cleanup failed"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fx.lifecycle.deactivate();
    expect(fx.pair.task.stop).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
