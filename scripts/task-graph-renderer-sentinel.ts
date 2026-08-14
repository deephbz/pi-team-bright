import fs from "node:fs";
import path from "node:path";
import { renderTaskGraphSentinel } from "../src/task-graph-view/sentinel";
import type { TaskGraphDirection } from "../src/task-graph-view/layout";

const artifacts: Array<{ direction: TaskGraphDirection; fixture: string }> = [
  { direction: "TB", fixture: "src/task-graph-view/fixtures/sentinel-120x42.txt" },
  { direction: "LR", fixture: "src/task-graph-view/fixtures/sentinel-lr-180x42.txt" },
];

if (process.argv.includes("--check")) {
  for (const artifact of artifacts) {
    const fixture = path.resolve(artifact.fixture);
    const expected = fs.readFileSync(fixture, "utf8");
    const rendered = renderTaskGraphSentinel(artifact.direction);
    if (rendered !== expected) {
      process.stderr.write(`Task graph ${artifact.direction} sentinel differs from ${fixture}. Run npm run render:task-graph:sentinel and review the output.\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`Task graph ${artifact.direction} sentinel matches ${fixture}.\n`);
    }
  }
} else {
  const direction = process.argv.includes("--lr") ? "LR" : "TB";
  process.stdout.write(renderTaskGraphSentinel(direction));
}
