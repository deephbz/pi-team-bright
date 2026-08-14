import fs from "node:fs";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  renderTaskGraphSentinel,
  TASK_GRAPH_LR_SENTINEL_WIDTH,
  TASK_GRAPH_SENTINEL_ROWS,
  TASK_GRAPH_SENTINEL_WIDTH,
} from "./sentinel";

describe("Task graph sentinel render quality", () => {
  it.each([
    ["TB" as const, "src/task-graph-view/fixtures/sentinel-120x42.txt", TASK_GRAPH_SENTINEL_WIDTH],
    ["LR" as const, "src/task-graph-view/fixtures/sentinel-lr-180x42.txt", TASK_GRAPH_LR_SENTINEL_WIDTH],
  ])("matches the fixed %s full-component artifact", (direction, fixture, width) => {
    const expected = fs.readFileSync(path.resolve(fixture), "utf8");
    const rendered = renderTaskGraphSentinel(direction);
    expect(rendered).toBe(expected);
    const lines = rendered.trimEnd().split("\n");
    expect(lines).toHaveLength(TASK_GRAPH_SENTINEL_ROWS);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("keeps the required visual signals in the TB review artifact", () => {
    const rendered = renderTaskGraphSentinel();
    expect(rendered).toContain("Task graph: task-dag-islands-gallery");
    expect(rendered).toContain("View: SELECT");
    expect(rendered).toContain("island 1/3");
    expect(rendered).toContain("Legend:");
    expect(rendered).toContain("Details: [in_progress] dag1-task2@worker2");
    expect(rendered).toContain("Goal: goal2:");
    expect(rendered).toContain("Context: context2:");
    expect(rendered).toContain("[dependency_waiting] dag1-task4@worker4");
    expect(rendered).toContain("updated 10m ago · elapsed 2h 55m");
    expect(rendered).toMatch(/[┏┓┗┛┣┫┳┻╋]/u);
    expect(rendered).toMatch(/[╌╎]/u);
    expect(rendered).not.toContain("╳");
    expect(rendered).toContain("Shortcuts:");
  });

  it("keeps LR arrows outside intact node borders", () => {
    const rendered = renderTaskGraphSentinel("LR");
    expect(rendered).toContain("▶│DAG 1 Task 3");
    expect(rendered).toContain("▶│⋈ ↺0/2 DAG 1 Task 4");
    expect(rendered).toMatch(/▲\n[^\n]*╎/u);
    expect(rendered).not.toContain("▶DAG 1");
  });
});
