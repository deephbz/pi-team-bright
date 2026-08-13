import { describe, expect, it } from "vitest";
import {
  TaskGraphValidationError,
  compileBeadsGraphPlan,
  dependencyReadiness,
  selectDispatchFrontier,
  validateTaskGraph,
  type GraphTaskState,
  type TaskGraphCreateInput,
} from "./dag";

const chain: TaskGraphCreateInput = {
  operation_id: "release-1",
  tasks: [
    { key: "plan", title: "Plan", goal: "Produce an accepted plan.", assignee: "maker" },
    { key: "impl", title: "Implement", goal: "Implement the accepted plan.", assignee: "maker" },
    { key: "review", title: "Review", goal: "Review the implementation.", assignee: "reviewer" },
  ],
  dependencies: [
    { task: { key: "impl" }, needs: [{ key: "plan" }] },
    { task: { key: "review" }, needs: [{ key: "impl" }] },
  ],
};

function task(id: string, assignee: string, blockedBy: string[] = [], status: GraphTaskState["status"] = "open"): GraphTaskState {
  return { id, title: id, goal: id, assignee, status, version: `v_${id.padEnd(16, "0").slice(0, 16)}`, blockedBy };
}

describe("Task DAG domain", () => {
  it("maps model needs to Beads blocks direction", () => {
    const plan = compileBeadsGraphPlan(chain);
    expect(plan.edges).toEqual([
      { from_key: "impl", to_key: "plan", type: "blocks" },
      { from_key: "review", to_key: "impl", type: "blocks" },
    ]);
  });

  it.each([
    ["duplicate_key", { ...chain, tasks: [...chain.tasks, chain.tasks[0]] }],
    ["unknown_key", { ...chain, dependencies: [{ task: { key: "impl" }, needs: [{ key: "missing" }] }] }],
    ["self_dependency", { ...chain, dependencies: [{ task: { key: "plan" }, needs: [{ key: "plan" }] }] }],
    ["duplicate_dependency", { ...chain, dependencies: [{ task: { key: "impl" }, needs: [{ key: "plan" }, { key: "plan" }] }] }],
    ["cycle", { ...chain, dependencies: [
      { task: { key: "plan" }, needs: [{ key: "review" }] },
      { task: { key: "impl" }, needs: [{ key: "plan" }] },
      { task: { key: "review" }, needs: [{ key: "impl" }] },
    ] }],
  ] as const)("refuses %s before mutation", (code, input) => {
    expect(() => validateTaskGraph(input as unknown as TaskGraphCreateInput)).toThrowError(TaskGraphValidationError);
    try { validateTaskGraph(input as unknown as TaskGraphCreateInput); } catch (error) { expect((error as TaskGraphValidationError).code).toBe(code); }
  });

  it("validates stable Workers and exact existing dependent versions", () => {
    const input: TaskGraphCreateInput = {
      operation_id: "expand",
      tasks: [{ key: "fix", title: "Fix", goal: "Fix the review.", assignee: "maker" }],
      dependencies: [{ task: { task_id: "review-1", expected_version: "v_expected0000000" }, needs: [{ key: "fix" }] }],
    };
    expect(() => validateTaskGraph(input, {
      workers: new Set(["maker"]),
      existingTasks: new Map([["review-1", { id: "review-1", version: "v_stale000000000", status: "open" }]]),
    })).toThrow(/changed/);
  });

  it("derives readiness only from active prerequisites and terminal state", () => {
    const tasks = new Map<string, GraphTaskState>([
      ["plan", task("plan", "maker", [], "closed")],
      ["impl", task("impl", "maker", ["plan"])],
    ]);
    expect(dependencyReadiness(tasks.get("impl")!, tasks)).toEqual({ kind: "ready", active_blocker_ids: [] });
    tasks.get("plan")!.status = "blocked";
    expect(dependencyReadiness(tasks.get("impl")!, tasks)).toEqual({ kind: "waiting", active_blocker_ids: ["plan"] });
  });

  it("selects parallel Workers but reserves one slot per Worker", () => {
    const tasks = [
      task("a", "maker"),
      task("b", "maker"),
      task("c", "reviewer"),
      task("d", "verifier", ["a"]),
    ];
    expect(selectDispatchFrontier(tasks, []).map((value) => value.id)).toEqual(["a", "c"]);
    expect(selectDispatchFrontier(tasks, [{ taskId: "a", taskVersion: tasks[0].version, worker: "maker", state: "presented" }]).map((value) => value.id)).toEqual(["c"]);
  });
});
