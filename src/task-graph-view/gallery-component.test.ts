import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTaskDagIslandsGalleryComponent } from "./gallery-component";
import { loadTaskDagIslandsGalleryConfig } from "./gallery-config";

const text = (lines: string[]): string => lines.join("\n");

describe("Task DAG islands gallery component", () => {
  const config = loadTaskDagIslandsGalleryConfig();

  it("renders both views from the same fixed-clock fixture within terminal bounds", () => {
    for (const view of ["dag", "timeline"] as const) {
      for (const [width, height] of [[80, 24], [120, 42]] as const) {
        const component = createTaskDagIslandsGalleryComponent(config, {
          rows: () => height, requestRender() {}, color: false, width, view,
        });
        const lines = component.render(width);
        expect(lines).toHaveLength(height);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(text(lines)).toContain(`· ${view.toUpperCase()} ·`);
        expect(text(lines)).toContain("fixed review clock 2026-08-14T12:00:00.000Z");
        if (view === "timeline") {
          expect(text(lines)).toContain("#1 completed");
          expect(text(lines)).toContain("#2 in_progress");
          expect(text(lines)).toContain("blocked");
          expect(text(lines)).toContain("timing unavailable");
          expect(text(lines)).toContain("ready; no Attempt");
        } else {
          expect(text(lines)).toContain("island 1/3");
          expect(text(lines)).toContain("dag1-task1");
        }
      }
    }
  });

  it("responds to view, selection, detail, state filter, and zoom keys", () => {
    const requestRender = vi.fn();
    const component = createTaskDagIslandsGalleryComponent(config, {
      rows: () => 42, requestRender, color: false, width: 120,
    });
    expect(text(component.render(120))).toContain("· DAG ·");
    component.handleInput("v");
    expect(text(component.render(120))).toContain("· TIMELINE ·");
    const beforeSelect = text(component.render(120));
    component.handleInput("j");
    const afterSelect = text(component.render(120));
    expect(afterSelect).not.toBe(beforeSelect);
    component.handleInput("\r");
    expect(text(component.render(120))).not.toBe(afterSelect);
    component.handleInput("+");
    expect(text(component.render(120))).toContain("zoom 2x");
    component.handleInput("s");
    expect(text(component.render(120))).not.toContain("all states");
    component.handleInput("\t");
    expect(text(component.render(120))).toContain("PAN · TIMELINE");
    expect(requestRender).toHaveBeenCalled();
  });
});
