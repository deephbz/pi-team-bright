import { GraphTaskController } from "../src/task-authority/graph-control";
import { layoutTaskGraph, renderTaskGraphViewport } from "../src/task-graph-view/layout";
import { projectGraphControlTaskGraphViewSource } from "../src/task-graph-view/source";

const controller = new GraphTaskController({
  default: "openai/default:medium",
  capable: "openai/capable:max",
});
controller.applyGraph({
  operationId: "renderer-smoke-apply",
  tasks: [
    { key: "build", title: "Build", goal: "Build the result.", assignee: "maker", modelAlias: "capable" },
    {
      key: "review",
      title: "Review",
      goal: "Accept the result.",
      assignee: "reviewer",
      needs: ["build"],
      onGoalFailed: { target: "build", maxTraversals: 2 },
    },
    { key: "verify", title: "Verify", goal: "Verify the accepted result.", assignee: "verifier", needs: ["review"] },
  ],
});
const build = controller.readTask("build");
controller.transition({
  taskId: "build",
  operationId: "renderer-smoke-claim",
  expectedVersion: build.version,
  transition: "claim",
  worker: build.assignee,
});

const source = projectGraphControlTaskGraphViewSource({
  teamName: "renderer-smoke",
  trace: controller.trace(),
});
const canvas = layoutTaskGraph(source, "all", { direction: "TB", nodeWidth: 34 });
const plain = renderTaskGraphViewport({
  canvas,
  x: 0,
  y: 0,
  width: canvas.width,
  height: canvas.height,
  color: false,
}).join("\n");
const signals = ["in_progress", "dependency_waiting", "↺0/2"];
if (/\u001b/u.test(plain)) throw new Error("Plain renderer leaked terminal control data.");
for (const signal of signals) {
  if (!plain.includes(signal)) throw new Error(`Renderer omitted ${JSON.stringify(signal)}.`);
}
process.stdout.write(`${JSON.stringify({
  schema: "task-graph-renderer-smoke/1",
  source_schema: source.schema,
  authority: source.authority,
  graph_version: source.graph_version,
  nodes: source.nodes.length,
  edges: source.edges.length,
  canvas: [canvas.width, canvas.height],
  plain_ansi_free: true,
  signals,
})}\n`);
