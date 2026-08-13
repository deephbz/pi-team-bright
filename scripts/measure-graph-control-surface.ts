import { writeFileSync } from "node:fs";
import { modelToolCatalog, TaskUpdateParametersSchema } from "../src/model-tool-contract/catalog";
import { GraphTaskUpdateParametersSchema, TaskGraphApplyParametersSchema } from "../src/task-authority/graph-control-schemas";

const compact = (value: unknown): string => JSON.stringify(value);
const current = modelToolCatalog.tools.map(tool => ({
  name: tool.name,
  description: tool.responsibility,
  parameters: tool.parameters,
}));
const proposed = current.map(tool => tool.name === "task_create"
  ? {
    name: "task_graph_apply",
    description: "Atomically apply or revise the complete mission Task graph and dispatch its derived ready front.",
    parameters: TaskGraphApplyParametersSchema,
  }
  : tool.name === "task_update"
    ? {
      name: "task_update",
      description: "Record Task context or apply one valid execution transition with exact replay and version checks.",
      parameters: GraphTaskUpdateParametersSchema,
    }
    : tool);

const output = {
  schema: "pi-team-bright-graph-control-surface-input/1",
  serialization: "JSON.stringify over provider name, description, and parameters in registration order",
  current: {
    tools: current,
    compactCharacters: compact(current).length,
    taskUpdateCompactCharacters: compact(TaskUpdateParametersSchema).length,
  },
  proposed: {
    tools: proposed,
    compactCharacters: compact(proposed).length,
    taskGraphApplyCompactCharacters: compact(TaskGraphApplyParametersSchema).length,
    taskUpdateCompactCharacters: compact(GraphTaskUpdateParametersSchema).length,
  },
};

const path = process.argv[2];
if (path) writeFileSync(path, JSON.stringify(output, null, 2) + "\n");
else process.stdout.write(JSON.stringify(output, null, 2) + "\n");
