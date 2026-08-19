import { describe, expect, it, vi } from "vitest";
import {
  RecipientDeliveryLifecycle,
  type RecipientDeliveryBinding,
  type RecipientDeliveryEngine,
  type RecipientDeliveryPair,
} from "./recipient-delivery-lifecycle";

type Binding = RecipientDeliveryBinding;
type Engine = RecipientDeliveryEngine;
type Pair = RecipientDeliveryPair;

function createLifecycle(makePair: (binding: Binding) => Pair): RecipientDeliveryLifecycle {
  return new RecipientDeliveryLifecycle({ makePair });
}

function binding(overrides: Partial<Binding> = {}): Binding {
  return {
    teamName: "recipient-delivery",
    recipient: "team-lead",
    membershipId: "membership-1",
    sessionFile: "/tmp/lead-1.jsonl",
    ...overrides,
  };
}

function pair(events: string[], options: { directFails?: boolean; taskFails?: boolean; directStart?: Promise<void> } = {}): Pair {
  const engine = (name: "direct" | "task", fails: boolean): Engine => ({
    start: vi.fn(async () => {
      events.push(`${name}:start`);
      if (name === "direct" && options.directStart) await options.directStart;
      if (fails) throw new Error(`${name} start failed`);
    }),
    stop: vi.fn(() => events.push(`${name}:stop`)),
    observeContext: vi.fn(async () => { events.push(`${name}:context`); return 0; }),
    commitPresentedAfterSuccessfulTurn: vi.fn(async () => { events.push(`${name}:commit`); return 0; }),
  });
  return { direct: engine("direct", !!options.directFails), task: engine("task", !!options.taskFails) };
}

describe("recipient-delivery lifecycle characterization", () => {
  it("activation from unbound", async () => {
    const events: string[] = [];
    const lifecycle = createLifecycle(() => pair(events));
    expect(lifecycle.binding).toBeUndefined();

    await lifecycle.activate(binding());

    expect(lifecycle.binding).toEqual(binding());
    expect(events).toEqual(["direct:start", "task:start"]);
  });

  it("deactivates an active pair and returns to unbound", async () => {
    const events: string[] = [];
    const lifecycle = createLifecycle(() => pair(events));
    await lifecycle.activate(binding());

    lifecycle.deactivate();

    expect(lifecycle.binding).toBeUndefined();
    expect(events).toEqual(["direct:start", "task:start", "direct:stop", "task:stop"]);
  });

  it("stops the old exact pair before binding its replacement", async () => {
    const events: string[] = [];
    const pairs: Pair[] = [];
    const lifecycle = createLifecycle(() => {
      const next = pair(events);
      pairs.push(next);
      return next;
    });
    await lifecycle.activate(binding());

    await lifecycle.activate(binding({ membershipId: "membership-2", sessionFile: "/tmp/lead-2.jsonl" }));

    expect(events).toEqual([
      "direct:start", "task:start", "direct:stop", "task:stop", "direct:start", "task:start",
    ]);
    expect(pairs).toHaveLength(2);
  });

  it("compensates direct-start failure without retaining a half-live pair", async () => {
    const events: string[] = [];
    const lifecycle = createLifecycle(() => pair(events, { directFails: true }));

    await expect(lifecycle.activate(binding())).rejects.toThrow("direct start failed");

    expect(lifecycle.binding).toBeUndefined();
    expect(events).toEqual(["direct:start", "direct:stop", "task:stop"]);
  });

  it("compensates task-start failure without retaining a half-live pair", async () => {
    const events: string[] = [];
    const lifecycle = createLifecycle(() => pair(events, { taskFails: true }));

    await expect(lifecycle.activate(binding())).rejects.toThrow("task start failed");

    expect(lifecycle.binding).toBeUndefined();
    expect(events).toEqual(["direct:start", "task:start", "direct:stop", "task:stop"]);
  });

  it("generation-fences activation when deactivation overlaps a pending start", async () => {
    const events: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const lifecycle = createLifecycle(() => pair(events, { directStart: pending }));

    const activation = lifecycle.activate(binding());
    lifecycle.deactivate();
    release();
    await activation;

    expect(lifecycle.binding).toBeUndefined();
    expect(events).toEqual(["direct:start", "direct:stop", "task:stop"]);
  });

  it("does not forward task context after the active pair is deactivated mid-forward", async () => {
    const events: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const lifecycle = createLifecycle(() => ({
      direct: { start: async () => undefined, stop: () => events.push("direct:stop"), observeContext: async () => { events.push("direct:context"); await pending; return 0; }, commitPresentedAfterSuccessfulTurn: async () => 0 },
      task: { start: async () => undefined, stop: () => events.push("task:stop"), observeContext: async () => { events.push("task:context"); return 0; }, commitPresentedAfterSuccessfulTurn: async () => 0 },
    }));
    await lifecycle.activate(binding());

    const forwarding = lifecycle.observeContext([]);
    lifecycle.deactivate();
    release();
    await forwarding;

    expect(events).toEqual(["direct:context", "direct:stop", "task:stop"]);
  });

  it("forwards context and successful-turn completion only while bound", async () => {
    const events: string[] = [];
    const lifecycle = createLifecycle(() => pair(events));
    await lifecycle.observeContext([]);
    await lifecycle.commitPresentedAfterSuccessfulTurn("stop");
    await lifecycle.activate(binding());
    events.length = 0;

    await lifecycle.observeContext([]);
    await lifecycle.commitPresentedAfterSuccessfulTurn("stop");
    lifecycle.deactivate();
    await lifecycle.observeContext([]);
    await lifecycle.commitPresentedAfterSuccessfulTurn("stop");

    expect(events).toEqual(["direct:context", "task:context", "direct:commit", "task:commit", "direct:stop", "task:stop"]);
  });
});
