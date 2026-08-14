import fs from "node:fs";
import path from "node:path";
import { renderTaskGraphSentinel } from "../src/task-graph-view/sentinel";

const fixture = path.resolve("src/task-graph-view/fixtures/sentinel-120x42.txt");
const rendered = renderTaskGraphSentinel();

if (process.argv.includes("--check")) {
  const expected = fs.readFileSync(fixture, "utf8");
  if (rendered !== expected) {
    process.stderr.write(`Task graph sentinel differs from ${fixture}. Run npm run render:task-graph:sentinel and review the output.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Task graph sentinel matches ${fixture}.\n`);
  }
} else {
  process.stdout.write(rendered);
}
