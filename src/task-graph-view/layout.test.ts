import { describe, expect, it } from "vitest";
import { GraphTaskController, type GraphTaskDefinitionInput } from "../task-authority/graph-control";
import { layoutTaskGraph, renderTaskGraphViewport } from "./layout";
import { projectGraphControlTaskGraphViewSource } from "./source";

function source() {
  const controller = new GraphTaskController({ default: "provider/default:medium", capable: "provider/capable:max" });
  controller.applyGraph({
    operationId: "graph",
    tasks: [
      { key: "plan", title: "Plan", goal: "Plan.", assignee: "planner" },
      { key: "build", title: "Build", goal: "Build.", assignee: "builder", modelAlias: "capable", needs: ["plan"] },
      { key: "test", title: "Test", goal: "Test.", assignee: "tester", needs: ["plan"] },
      {
        key: "ship",
        title: "Ship",
        goal: "Ship.",
        assignee: "shipper",
        needs: ["build", "test"],
        onGoalFailed: { target: "plan", maxTraversals: 2 },
      },
    ],
  });
  const plan = controller.readTask("plan");
  controller.transition({ taskId: "plan", operationId: "plan-claim", expectedVersion: plan.version, transition: "claim", worker: "planner" });
  return projectGraphControlTaskGraphViewSource({ teamName: "graph-team", trace: controller.trace() });
}

function islands(count: number, islandSize = 5) {
  const tasks: GraphTaskDefinitionInput[] = Array.from({ length: count }, (_, index) => {
    const position = index % islandSize;
    const root = index - position;
    return {
      key: `task-${index}`,
      title: `Task ${index}`,
      goal: "Pass.",
      assignee: `worker-${index % 8}`,
      ...(position ? { needs: [`task-${index - 1}`] } : {}),
      ...(position === islandSize - 1 ? { onGoalFailed: { target: `task-${root}`, maxTraversals: 2 } } : {}),
    };
  });
  const controller = new GraphTaskController({ default: "provider/default", capable: "provider/capable" });
  controller.applyGraph({ operationId: `islands-${count}`, tasks });
  return projectGraphControlTaskGraphViewSource({ teamName: `islands-${count}`, trace: controller.trace() });
}

describe("Task graph terminal layout", () => {
  it("is deterministic and renders graph-control state, typed routes, joins, Attempts, and model detail", () => {
    const first = layoutTaskGraph(source(), "all", { direction: "TB", nodeWidth: 32 });
    const second = layoutTaskGraph(source(), "all", { direction: "TB", nodeWidth: 32 });
    expect(first).toEqual(second);
    expect(first.islands).toHaveLength(1);
    const plain = renderTaskGraphViewport({ canvas: first, x: 0, y: 0, width: first.width, height: first.height, color: false }).join("\n");
    expect(plain).toContain("island 1/1 · 4 tasks");
    expect(plain).toContain("▶ in_progress");
    expect(plain).toContain("◷ dependency_waiting ⋈ ↺0/2");
    expect(plain).toContain("try 1/1 · default current");
    expect(plain).toContain("tries 0 · capable");
    expect(plain).toMatch(/[━┃]/u);
    expect(plain).toMatch(/[╌╎]/u);
    expect(plain).toContain("↺0/2");
    expect(plain).not.toContain("\u001b");
  });

  it("packs disconnected islands without the all-at-once Dagre crash", () => {
    const graph = islands(20);
    const first = layoutTaskGraph(graph, "all", { packWidth: 120, nodeWidth: 24 });
    const second = layoutTaskGraph(graph, "all", { packWidth: 120, nodeWidth: 24 });
    expect(first).toEqual(second);
    expect(first.islands).toHaveLength(4);
    expect(first.islands.map((island) => island.id)).toEqual(["task-0", "task-10", "task-15", "task-5"]);
    expect(new Set(first.islands.map((island) => `${island.x},${island.y}`)).size).toBe(4);
    expect(first.width).toBeLessThanOrEqual(160);
    expect(first.height).toBeGreaterThan(50);
  });

  it("keeps recency/filter omissions and graph boundaries visible to the component", () => {
    const graph = islands(100);
    const canvas = layoutTaskGraph(graph, 25, { stateFilter: "actionable", packWidth: 160 });
    expect(canvas.visible.nodes).toHaveLength(20);
    expect(canvas.visible.recencyOmittedNodeCount).toBe(0);
    expect(canvas.visible.filterOmittedNodeCount).toBe(80);
    expect(canvas.visible.boundaryEdgeCount).toBeGreaterThan(0);
    expect(canvas.visible.omittedNodeCount).toBe(80);
  });

  it("keeps failure self-loops and backward repair lanes legible beside node boxes", () => {
    const controller = new GraphTaskController({ default: "provider/default", capable: "provider/capable" });
    controller.applyGraph({ operationId: "repair-routes", tasks: [
      {
        key: "self",
        title: "Retry itself",
        goal: "Pass.",
        assignee: "worker-self",
        onGoalFailed: { target: "self", maxTraversals: 2 },
      },
      { key: "root", title: "Root", goal: "Pass.", assignee: "worker-root" },
      {
        key: "repair",
        title: "Repair",
        goal: "Pass.",
        assignee: "worker-repair",
        needs: ["root"],
        onGoalFailed: { target: "root", maxTraversals: 3 },
      },
    ] });
    const canvas = layoutTaskGraph(
      projectGraphControlTaskGraphViewSource({ teamName: "repair-routes", trace: controller.trace() }),
      "all",
      { packWidth: 120, nodeWidth: 24 },
    );
    const plain = renderTaskGraphViewport({ canvas, x: 0, y: 0, width: canvas.width, height: canvas.height, color: false }).join("\n");
    expect(canvas.islands).toHaveLength(2);
    expect(plain).toContain("×0/2");
    expect(plain).toContain("×0/3");
    expect(plain).toMatch(/[╌╎]/u);
    expect(plain).toContain("↺0/2");
    expect(canvas.visible.edges).toContainEqual({
      from_task_id: "repair",
      to_task_id: "root",
      kind: "goal_failed",
      traversals: 0,
      max_traversals: 3,
    });
  });

  it("packs several single-node islands deterministically", () => {
    const controller = new GraphTaskController({ default: "provider/default", capable: "provider/capable" });
    controller.applyGraph({ operationId: "singletons", tasks: Array.from({ length: 12 }, (_, index) => ({
      key: `single-${String(index).padStart(2, "0")}`,
      title: `Single ${index}`,
      goal: "Pass.",
      assignee: "worker",
    })) });
    const graph = projectGraphControlTaskGraphViewSource({ teamName: "singletons", trace: controller.trace() });
    const first = layoutTaskGraph(graph, "all", { packWidth: 100, nodeWidth: 24 });
    expect(first.islands).toHaveLength(12);
    expect(first.islands.map(({ x, y }) => `${x},${y}`)).toEqual(
      layoutTaskGraph(graph, "all", { packWidth: 100, nodeWidth: 24 }).islands.map(({ x, y }) => `${x},${y}`),
    );
    expect(new Set(first.islands.map(({ x, y }) => `${x},${y}`))).toHaveLength(12);
  });

  it("clips a packed canvas without changing its cached island coordinates", () => {
    const canvas = layoutTaskGraph(islands(100), "all", { direction: "LR", packWidth: 180 });
    const islandsBefore = structuredClone(canvas.islands);
    const viewport = renderTaskGraphViewport({ canvas, x: 10_000, y: 10_000, width: 20, height: 5, color: false });
    expect(viewport).toHaveLength(5);
    expect(viewport.every((line) => line.length === 20)).toBe(true);
    expect(canvas.islands).toEqual(islandsBefore);
  });
});
