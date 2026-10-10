import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactionDeliveryGate, EXTERNAL_HOLD_LIMIT_MS, type CompactionDeliveryGateClock } from "./compaction-delivery-gate";

function manualClock() {
  const deferred: Array<() => void> = [];
  const timers = new Map<number, () => void>();
  let next = 0;
  const clock: CompactionDeliveryGateClock = {
    defer: (callback) => { deferred.push(callback); },
    setTimeout: (callback) => { timers.set(++next, callback); return next; },
    clearTimeout: (handle) => { timers.delete(handle as number); },
  };
  return {
    clock,
    runDeferred: () => { for (const callback of deferred.splice(0)) callback(); },
    fireTimers: () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    timerCount: () => timers.size,
  };
}

function harness() {
  const time = manualClock();
  const gate = new CompactionDeliveryGate({ clock: time.clock });
  const pi = { sendMessage: vi.fn(), appendEntry: vi.fn() };
  const sink = gate.sink(pi as any);
  const send = (id: string) => sink.sendMessage({ customType: "t", content: id, display: true }, { triggerTurn: true, deliverAs: "steer" });
  const sent = () => pi.sendMessage.mock.calls.map(([message]) => message.content);
  return { time, gate, pi, sink, send, sent };
}

describe("compaction delivery gate", () => {
  afterEach(() => vi.useRealTimers());

  it("holds synchronously, renews idempotently, and ignores mismatched ends", () => {
    const test = harness();
    test.gate.beginExternal("hc-auto-compact", "run-1");
    test.gate.beginExternal("hc-auto-compact", "run-1");
    expect(test.time.timerCount()).toBe(1);
    test.send("a");
    test.gate.endExternal("hc-auto-compact", "wrong-token");
    test.gate.endExternal("wrong-holder", "run-1");
    test.time.runDeferred();
    expect(test.sent()).toEqual([]);
    test.gate.endExternal("hc-auto-compact", "run-1");
    test.gate.endExternal("hc-auto-compact", "run-1");
    test.send("b");
    test.time.runDeferred();
    expect(test.sent()).toEqual(["a", "b"]);
    expect(test.time.timerCount()).toBe(0);
  });

  it.each(["native-first", "external-first"])("waits for both hold owners: %s", order => {
    const test = harness();
    test.gate.beginExternal("hc-auto-compact", "run");
    test.gate.begin();
    test.send("a");
    if (order === "native-first") test.gate.end();
    else test.gate.endExternal("hc-auto-compact", "run");
    test.time.runDeferred();
    expect(test.sent()).toEqual([]);
    if (order === "native-first") test.gate.endExternal("hc-auto-compact", "run");
    else test.gate.end();
    test.time.runDeferred();
    expect(test.sent()).toEqual(["a"]);
  });

  it("keeps distinct tokens held and fences a begin before a pending flush", () => {
    const test = harness();
    test.gate.beginExternal("hc-auto-compact", "old");
    test.send("a");
    test.gate.endExternal("hc-auto-compact", "old");
    test.gate.beginExternal("hc-auto-compact", "new");
    test.gate.beginExternal("other", "second");
    test.time.runDeferred();
    expect(test.sent()).toEqual([]);
    test.gate.endExternal("hc-auto-compact", "new");
    test.time.runDeferred();
    expect(test.sent()).toEqual([]);
    test.gate.endExternal("other", "second");
    test.time.runDeferred();
    expect(test.sent()).toEqual(["a"]);
  });

  it("renews the 30-minute lease and warns once when it expires", () => {
    vi.useFakeTimers();
    const onExternalHoldExpired = vi.fn();
    const gate = new CompactionDeliveryGate({ onExternalHoldExpired });
    const pi = { sendMessage: vi.fn(), appendEntry: vi.fn() };
    const sink = gate.sink(pi as any);
    gate.beginExternal("hc-auto-compact", "run");
    sink.sendMessage({ customType: "t", content: "a", display: true });
    vi.advanceTimersByTime(EXTERNAL_HOLD_LIMIT_MS - 1);
    gate.beginExternal("hc-auto-compact", "run");
    vi.advanceTimersByTime(EXTERNAL_HOLD_LIMIT_MS - 1);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(onExternalHoldExpired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExternalHoldExpired).toHaveBeenCalledExactlyOnceWith("hc-auto-compact", "run");
    vi.runAllTimers();
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(gate.isClosed).toBe(false);
  });

  it("does not let external expiry release an active native hold", () => {
    vi.useFakeTimers();
    const warning = vi.fn();
    const gate = new CompactionDeliveryGate({ holdLimitMs: EXTERNAL_HOLD_LIMIT_MS * 2, onExternalHoldExpired: warning });
    gate.begin();
    gate.beginExternal("hc-auto-compact", "run");
    vi.advanceTimersByTime(EXTERNAL_HOLD_LIMIT_MS);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(gate.isClosed).toBe(true);
    gate.end();
    vi.runAllTimers();
    expect(gate.isClosed).toBe(false);
  });

  it("keeps the external hold when the native lease expires", () => {
    vi.useFakeTimers();
    const gate = new CompactionDeliveryGate();
    gate.begin();
    gate.beginExternal("hc-auto-compact", "run");
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(gate.isClosed).toBe(true);
    gate.endExternal("hc-auto-compact", "run");
    vi.runAllTimers();
    expect(gate.isClosed).toBe(false);
  });

  it("stops a flush if a sender begins a new hold and keeps queued order", () => {
    const test = harness();
    test.pi.sendMessage.mockImplementationOnce(() => {
      test.gate.beginExternal("hc-auto-compact", "second");
      test.send("c");
    });
    test.gate.beginExternal("hc-auto-compact", "first");
    test.send("a");
    test.send("b");
    test.gate.endExternal("hc-auto-compact", "first");
    test.time.runDeferred();
    expect(test.sent()).toEqual(["a"]);
    test.gate.endExternal("hc-auto-compact", "second");
    test.time.runDeferred();
    expect(test.sent()).toEqual(["a", "b", "c"]);
  });

  it("reset cancels external leases, stale flushes, and old-Session sends", () => {
    const test = harness();
    test.gate.beginExternal("hc-auto-compact", "run");
    test.send("old");
    test.gate.reset();
    test.time.fireTimers();
    test.time.runDeferred();
    expect(test.sent()).toEqual([]);
    expect(test.time.timerCount()).toBe(0);
    expect(test.gate.isClosed).toBe(false);
    test.send("new");
    expect(test.sent()).toEqual(["new"]);
  });

  it("sends directly while the Session is not compacting", () => {
    const test = harness();
    test.send("a");
    expect(test.sent()).toEqual(["a"]);
    expect(test.pi.sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  it("holds sends during compaction and flushes them in order after Pi's compaction tail", () => {
    const test = harness();
    test.gate.begin();
    test.send("a");
    test.send("b");
    expect(test.sent()).toEqual([]);
    test.gate.end();
    // Pi emits session_compact before it clears its compaction state.
    test.send("c");
    expect(test.sent()).toEqual([]);
    expect(test.gate.isClosed).toBe(true);
    test.time.runDeferred();
    expect(test.sent()).toEqual(["a", "b", "c"]);
    expect(test.gate.isClosed).toBe(false);
    test.send("d");
    expect(test.sent()).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps Session entries direct so persisted records never wait", () => {
    const test = harness();
    test.gate.begin();
    test.sink.appendEntry("ack", { id: 1 });
    expect(test.pi.appendEntry).toHaveBeenCalledWith("ack", { id: 1 });
  });

  it("keeps holding when a second compaction starts before the flush", () => {
    const test = harness();
    test.gate.begin();
    test.send("a");
    test.gate.end();
    test.gate.begin();
    test.time.runDeferred();
    expect(test.sent()).toEqual([]);
    test.gate.end();
    test.time.runDeferred();
    expect(test.sent()).toEqual(["a"]);
  });

  it("drops held sends when the Session changes", () => {
    const test = harness();
    test.gate.begin();
    test.send("old-session");
    test.gate.reset();
    test.time.runDeferred();
    expect(test.sent()).toEqual([]);
    expect(test.gate.isClosed).toBe(false);
    expect(test.time.timerCount()).toBe(0);
  });

  it("opens after the hold limit when Pi reports no compaction end", () => {
    const test = harness();
    test.gate.begin();
    test.send("a");
    test.time.fireTimers();
    test.time.runDeferred();
    expect(test.sent()).toEqual(["a"]);
  });

  it("ignores an end without a matching begin", () => {
    const test = harness();
    test.gate.end();
    expect(test.gate.isClosed).toBe(false);
  });

  it("notifies open listeners after held sends flush", () => {
    const test = harness();
    const order: string[] = [];
    test.pi.sendMessage.mockImplementation((message: any) => order.push(`send:${message.content}`));
    test.gate.onOpen(() => order.push("open"));
    test.gate.begin();
    test.send("a");
    test.gate.end();
    test.time.runDeferred();
    expect(order).toEqual(["send:a", "open"]);
  });

  it("continues the flush when one held send throws", () => {
    const time = manualClock();
    const onError = vi.fn();
    const gate = new CompactionDeliveryGate({ clock: time.clock, onError });
    const pi = { sendMessage: vi.fn().mockImplementationOnce(() => { throw new Error("stale"); }), appendEntry: vi.fn() };
    const sink = gate.sink(pi as any);
    gate.begin();
    sink.sendMessage({ customType: "t", content: "a", display: true }, { triggerTurn: true, deliverAs: "steer" });
    sink.sendMessage({ customType: "t", content: "b", display: true }, { triggerTurn: true, deliverAs: "steer" });
    gate.end();
    time.runDeferred();
    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
