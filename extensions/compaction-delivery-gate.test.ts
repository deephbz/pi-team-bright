import { describe, expect, it, vi } from "vitest";
import { CompactionDeliveryGate, type CompactionDeliveryGateClock } from "./compaction-delivery-gate";

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
