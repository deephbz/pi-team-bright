import { performance } from "node:perf_hooks";
import { GraphTaskController, type GraphTaskDefinitionInput } from "../src/task-authority/graph-control";
import { layoutTaskGraph, renderTaskGraphViewport } from "../src/task-graph-view/layout";
import { projectGraphControlTaskGraphViewSource } from "../src/task-graph-view/source";

const ISLAND_SIZE = 5;
const ITERATIONS = 15;

function taskId(index: number): string {
  return `task-${String(index).padStart(3, "0")}`;
}

function source(count: number) {
  const tasks: GraphTaskDefinitionInput[] = Array.from({ length: count }, (_, index) => {
    const position = index % ISLAND_SIZE;
    const root = index - position;
    return {
      key: taskId(index),
      title: `Representative Task ${index}`,
      goal: "Benchmark the graph renderer.",
      assignee: `worker-${index % 8}`,
      ...(position ? { needs: [taskId(index - 1)] } : {}),
      ...(position === ISLAND_SIZE - 1 ? {
        onGoalFailed: { target: taskId(root), maxTraversals: 2 },
      } : {}),
    };
  });
  const controller = new GraphTaskController({ default: "provider/default", capable: "provider/capable" });
  controller.applyGraph({ operationId: `benchmark-${count}`, tasks });
  return projectGraphControlTaskGraphViewSource({ teamName: `benchmark-${count}`, trace: controller.trace() });
}

function percentile(values: number[], fraction: number): number {
  return [...values].sort((left, right) => left - right)[Math.floor((values.length - 1) * fraction)];
}

function measure(count: number) {
  const graph = source(count);
  const layoutMs: number[] = [];
  const panMs: number[] = [];
  let canvas = layoutTaskGraph(graph, "all", { packWidth: 240 });
  for (let index = 0; index < ITERATIONS; index++) {
    let start = performance.now();
    canvas = layoutTaskGraph(graph, "all", { packWidth: 240 });
    layoutMs.push(performance.now() - start);
    start = performance.now();
    renderTaskGraphViewport({ canvas, x: index * 3, y: index * 2, width: 80, height: 24, color: true });
    panMs.push(performance.now() - start);
  }
  return {
    nodes: count,
    islands: canvas.islands.length,
    edges: graph.edges.length,
    layout_p50_ms: Number(percentile(layoutMs, 0.5).toFixed(3)),
    layout_p95_ms: Number(percentile(layoutMs, 0.95).toFixed(3)),
    viewport_p50_ms: Number(percentile(panMs, 0.5).toFixed(3)),
    viewport_p95_ms: Number(percentile(panMs, 0.95).toFixed(3)),
    canvas: { width: canvas.width, height: canvas.height },
  };
}

process.stdout.write(`${JSON.stringify({
  schema: "task-graph-layout-benchmark/2",
  iterations: ITERATIONS,
  island_size: ISLAND_SIZE,
  results: [measure(20), measure(100), measure(500)],
}, null, 2)}\n`);
