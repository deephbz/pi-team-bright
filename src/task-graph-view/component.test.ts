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
  return projectGraphControlTaskGraphViewSource({ teamName: "component-team", trace: controller.trace() });
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
    });
    component.render(140);
    component.handleInput("s");
    const rendered = plain(component.render(140));
    expect(rendered).toContain("recent 25 · actionable");
    expect(rendered).toContain("−0 recent/−80 filtered/−40 boundary");
    expect(rendered).toContain("graph control · rev 1-");
    expect(rendered).toContain("island 1/20 · view 0,0");
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("navigates packed islands, clamps panning, and resets to the first origin", () => {
    const component = new TaskGraphPaneComponent({
      source: source(),
      initialLimit: "all",
      terminalRows: () => 20,
      requestRender: vi.fn(),
    });
    component.render(120);
    component.handleInput("]");
    let rendered = plain(component.render(120));
    expect(rendered).toMatch(/island 2\/4 · view [1-9][0-9]*,[0-9]+/u);
    for (let index = 0; index < 100; index++) component.handleInput("l");
    rendered = plain(component.render(120));
    const coordinate = /view ([0-9]+),([0-9]+)/u.exec(rendered);
    expect(coordinate).not.toBeNull();
    expect(Number(coordinate![1])).toBeLessThan(400);
    component.handleInput("\u001b[H");
    rendered = plain(component.render(120));
    expect(rendered).toContain("island 1/4 · view 0,0");
  });
});
