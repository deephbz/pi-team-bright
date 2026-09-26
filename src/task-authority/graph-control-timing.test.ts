import { describe, expect, it } from "vitest";
import { GraphTaskController, type GraphControlSnapshot } from "./graph-control";

const task = { key: "task", title: "Task", goal: "Pass.", assignee: "worker", onGoalFailed: { target: "task", maxTraversals: 1 } };

function clock(...instants: string[]): () => Date {
  let index = 0;
  return () => new Date(instants[index++] ?? "2030-01-01T00:00:00.000Z");
}

function transition(controller: GraphTaskController, kind: "claim" | "block" | "resume" | "goal_failed", operationId: string): void {
  const current = controller.readTask("task");
  controller.transition({
    taskId: "task",
    operationId,
    expectedVersion: current.version,
    transition: kind,
    worker: "worker",
    ...(kind === "block" || kind === "goal_failed" ? { evidence: "Observed result." } : {}),
  });
}

describe("graph authority recorded time", () => {
  it("records one canonical time per accepted command, persists it, and does not restamp replay", () => {
    const times = [
      "2030-01-01T00:00:00.000Z",
      "2030-01-01T00:01:00.000Z",
      "2030-01-01T00:02:00.000Z",
    ];
    const controller = new GraphTaskController(undefined, clock(...times));
    const apply = controller.applyGraph({ operationId: "graph", tasks: [task] });
    transition(controller, "claim", "claim");
    transition(controller, "goal_failed", "failed");
    const beforeReplay = controller.snapshot();
    expect(beforeReplay.graphRevisions[0].recorded_at).toBe(times[0]);
    expect(beforeReplay.events.find((event) => event.kind === "attempt_started")?.recorded_at).toBe(times[1]);
    expect(beforeReplay.events.filter((event) => event.operationId === "failed").map((event) => event.recorded_at))
      .toEqual([times[2], times[2]]);
    expect(controller.applyGraph({ operationId: "graph", tasks: [task] })).toMatchObject({
      replayed: true,
      graphVersion: apply.graphVersion,
    });
    expect(controller.snapshot()).toEqual(beforeReplay);

    const persisted = JSON.parse(JSON.stringify(beforeReplay)) as GraphControlSnapshot;
    const recovered = GraphTaskController.recover(persisted, clock("2040-01-01T00:00:00.000Z"));
    expect(recovered.snapshot()).toEqual(beforeReplay);
    expect(recovered.trace()).toEqual(controller.trace());
    expect(recovered.applyGraph({ operationId: "graph", tasks: [task] }).replayed).toBe(true);
    expect(recovered.snapshot()).toEqual(beforeReplay);
  });

  it("does not put wall time into graph or Task semantic versions", () => {
    const early = new GraphTaskController(undefined, clock("2030-01-01T00:00:00.000Z", "2030-01-01T00:01:00.000Z"));
    const late = new GraphTaskController(undefined, clock("2040-01-01T00:00:00.000Z", "2040-01-01T00:01:00.000Z"));
    for (const controller of [early, late]) {
      controller.applyGraph({ operationId: "graph", tasks: [task] });
      transition(controller, "claim", "claim");
    }
    expect(early.currentGraphVersion()).toBe(late.currentGraphVersion());
    expect(early.readTask("task").version).toBe(late.readTask("task").version);
    expect(early.snapshot().events[0].recorded_at).not.toBe(late.snapshot().events[0].recorded_at);
  });

  it("accepts legacy snapshots without timing and stamps only new commands", () => {
    const old = new GraphTaskController(undefined, clock("2030-01-01T00:00:00.000Z", "2030-01-01T00:01:00.000Z"));
    old.applyGraph({ operationId: "graph", tasks: [task] });
    transition(old, "claim", "claim");
    const snapshot = old.snapshot();
    for (const revision of snapshot.graphRevisions) delete revision.recorded_at;
    for (const event of snapshot.events) delete event.recorded_at;
    const recovered = GraphTaskController.recover(snapshot, clock("2030-01-01T00:02:00.000Z"));
    expect(recovered.applyGraph({ operationId: "graph", tasks: [task] }).replayed).toBe(true);
    expect(recovered.snapshot()).toEqual(snapshot);
    transition(recovered, "block", "block");
    expect(recovered.snapshot().events.map((event) => event.recorded_at)).toEqual([
      undefined,
      "2030-01-01T00:02:00.000Z",
    ]);
  });
});
