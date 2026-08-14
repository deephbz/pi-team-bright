import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { GraphTaskController, type GraphTaskDefinitionInput } from "../task-authority/graph-control";
import { TaskGraphPaneComponent } from "./component";
import { projectGraphControlTaskGraphViewSource } from "./source";

function source(count = 20, islandSize = 5) {
  const tasks: GraphTaskDefinitionInput[] = Array.from({ length: count }, (_, index) => {
    const position = index % islandSize;
    const root = index - position;
    return {
      key: `task-${String(index).padStart(3, "0")}`,
      title: `Task ${index}`,
      goal: "Pass.",
      assignee: `worker-${index % 4}`,
      ...(position ? { needs: [`task-${String(index - 1).padStart(3, "0")}`] } : {}),
      ...(position === islandSize - 1 ? {
        onGoalFailed: { target: `task-${String(root).padStart(3, "0")}`, maxTraversals: 2 },
      } : {}),
    };
  });
  const controller = new GraphTaskController({ default: "provider/default", capable: "provider/capable" });
  controller.applyGraph({ operationId: `component-${count}`, tasks });
  return projectGraphControlTaskGraphViewSource({
    teamName: "component-team",
    trace: controller.trace(),
    activity: {
      headCursor: String(count),
      tasks: controller.readTasks().map((task, index) => ({
        taskId: task.id,
        cursor: String(index + 1),
        firstActivityAt: "2026-08-14T08:00:00.000Z",
        lastActivityAt: "2026-08-14T09:00:00.000Z",
      })),
    },
  });
}

function plain(lines: string[]): string {
  return lines.join("\n").replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

describe("Task graph pane component", () => {
  it("cycles state filters and keeps omission plus authority freshness visible", () => {
    const requestRender = vi.fn();
    const component = new TaskGraphPaneComponent({
      source: source(100),
      initialLimit: 25,
      terminalRows: () => 30,
      requestRender,
      now: () => Date.parse("2026-08-14T10:00:00.000Z"),
    });
    component.render(140);
    component.handleInput("s");
    const rendered = plain(component.render(140));
    expect(rendered).toContain("recent 25 · actionable");
    const lines = rendered.split("\n");
    expect(lines[0]).toMatch(/^Task graph: component-team · graph control · rev /u);
    expect(lines[1]).toContain("View: PAN");
    expect(lines[1]).toContain("hidden 80 tasks/40 edges");
    expect(lines[2]).toMatch(/^Legend:/u);
    expect(rendered).toContain("island 1/20 · offset 0,0");
    expect(rendered).toContain("updated 1h 0m ago · elapsed 2h 0m");
    expect(lines.at(-1)).toMatch(/^Shortcuts:/u);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("navigates packed islands, clamps panning, and resets to the first origin", () => {
    const component = new TaskGraphPaneComponent({
      source: source(),
      initialLimit: "all",
      terminalRows: () => 20,
      requestRender: vi.fn(),
      now: () => Date.parse("2026-08-14T10:00:00.000Z"),
    });
    component.render(120);
    component.handleInput("]");
    let rendered = plain(component.render(120));
    expect(rendered).toMatch(/island 2\/4 · offset [1-9][0-9]*,[0-9]+/u);
    for (let index = 0; index < 100; index++) component.handleInput("l");
    rendered = plain(component.render(120));
    const coordinate = /offset ([0-9]+),([0-9]+)/u.exec(rendered);
    expect(coordinate).not.toBeNull();
    expect(Number(coordinate![1])).toBeLessThan(400);
    component.handleInput("\u001b[H");
    rendered = plain(component.render(120));
    expect(rendered).toContain("island 1/4 · offset 0,0");
  });

  it("switches to node selection, navigates with hjkl, expands one bounded detail panel, and preserves line width", () => {
    const requestRender = vi.fn();
    const component = new TaskGraphPaneComponent({
      source: source(5, 5),
      initialLimit: "all",
      terminalRows: () => 30,
      requestRender,
      now: () => Date.parse("2026-08-14T10:00:00.000Z"),
      color: false,
    });
    component.render(80);
    component.handleInput("\t");
    let lines = component.render(80);
    expect(lines[1]).toContain("View: SELECT");
    expect(lines.at(-1)).toContain("Enter details");
    component.handleInput("\r");
    lines = component.render(80);
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Details: \[/u),
      expect.stringMatching(/^Timing: first observed 2026-08-14 08:00:00Z/u),
      expect.stringMatching(/^Goal: Pass\./u),
      expect.stringMatching(/^Context: Work has not started\./u),
    ]));
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
    component.handleInput("j");
    expect(component.render(80).some((line) => line.startsWith("Details:"))).toBe(false);
    expect(requestRender).toHaveBeenCalled();
  });
});
