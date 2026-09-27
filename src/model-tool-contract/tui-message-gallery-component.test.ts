import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TuiMessageGalleryComponent } from "./tui-message-gallery-component";
import { tuiMessageGallery } from "./tui-message-gallery";

const plain = (lines: string[]): string => lines.join("\n").replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");

describe("TUI message gallery component", () => {
  it("navigates actual scenarios, toggles detail, scrolls, and quits", () => {
    const scenarios = tuiMessageGallery();
    const initialScenarioId = "custom.framework-sync";
    const selected = scenarios.findIndex((scenario) => scenario.id === initialScenarioId);
    expect(selected).toBeGreaterThan(0);
    let rows = 8;
    const requestRender = vi.fn();
    const quit = vi.fn();
    const component = new TuiMessageGalleryComponent({
      scenarios, terminalRows: () => rows, requestRender, quit, initialScenarioId,
    });
    const initial = plain(component.render(80));
    expect(initial).toContain(initialScenarioId);
    expect(initial).toContain("detail: off");
    expect(initial).toContain("[pi-team-bright.team_sync]");

    component.handleInput("\x0f"); // Ctrl+O
    const detail = plain(component.render(80));
    expect(detail).toContain("detail: on");
    expect(detail).toMatch(/rows: 1-4\/\d{2}/);
    component.handleInput("j");
    const scrolled = plain(component.render(80));
    expect(scrolled).toMatch(/rows: 2-/);
    component.handleInput("k");
    expect(plain(component.render(80))).toMatch(/rows: 1-/);
    let revealedDetail = false;
    for (let step = 0; step < 15; step += 1) {
      component.handleInput("j");
      revealedDetail ||= plain(component.render(80)).includes("details:");
    }
    expect(revealedDetail).toBe(true);

    component.handleInput("l");
    expect(plain(component.render(80))).toContain(scenarios[(selected + 1) % scenarios.length].id);
    expect(plain(component.render(80))).toMatch(/rows: 1-/);
    component.handleInput("h");
    expect(plain(component.render(80))).toContain(initialScenarioId);
    rows = 24;
    for (const width of [80, 120]) {
      const rendered = component.render(width);
      expect(rendered.length).toBeLessThanOrEqual(rows);
      for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    component.handleInput("q");
    expect(quit).toHaveBeenCalledOnce();
    expect(requestRender).toHaveBeenCalled();
  });

  it("rejects an unknown start scene instead of silently showing another message", () => {
    expect(() => new TuiMessageGalleryComponent({
      scenarios: tuiMessageGallery(), terminalRows: () => 24,
      requestRender() {}, quit() {}, initialScenarioId: "missing.scene",
    })).toThrow(/Unknown message gallery scenario/);
  });
});
