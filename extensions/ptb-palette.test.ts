import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createPtbPaletteComponent, openPtbPalette, type PtbPaletteItem } from "./ptb-palette";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
} as any;

const items: PtbPaletteItem[] = [
  { id: "status", tab: "Actions", label: "Team status", description: "Inspect the current Team." },
  { id: "model", tab: "Models", label: "Default model role", description: "Choose a role.", currentValue: "review", values: ["review", "fast"] },
  { id: "team", tab: "Team", label: "Team layout", description: "Adjust the pane layout." },
  { id: "worker", tab: "Workers", label: "Worker tools", description: "Review tool policy." },
];

describe("/ptb palette component", () => {
  it("shows four tabs within terminal width and selects from the active tab", () => {
    const requestRender = vi.fn();
    const done = vi.fn();
    const component = createPtbPaletteComponent({ items, isCurrent: () => true }, { requestRender }, theme, done);
    for (const width of [40, 80, 120]) {
      const lines = component.render(width);
      expect(lines.join("\n")).toContain("Team status");
      expect(lines.join("\n")).toContain("Tab/Shift+Tab");
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    component.handleInput("\t");
    expect(component.render(80).join("\n")).toContain("Default model role");
    expect(component.render(80).join("\n")).not.toContain("Team status");
    component.handleInput("\x1b[Z");
    expect(component.render(80).join("\n")).toContain("Team status");
    component.handleInput("\r");
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({ id: "status", tab: "Actions" });
    component.handleInput("\t");
    expect(done).toHaveBeenCalledOnce();
    expect(requestRender).toHaveBeenCalled();
  });

  it("cancels on Escape or a stale owner and never selects a disabled item", () => {
    const done = vi.fn();
    const component = createPtbPaletteComponent({
      items: [{ id: "disabled", tab: "Actions", label: "Unavailable action", description: "Needs a Team.", disabledReason: "No Team" }],
      isCurrent: () => true,
    }, { requestRender() {} }, theme, done);
    component.handleInput("\r");
    expect(done).not.toHaveBeenCalled();
    component.handleInput("\x1b");
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined);

    let current = true;
    const staleDone = vi.fn();
    const stale = createPtbPaletteComponent({ items, isCurrent: () => current }, { requestRender() {} }, theme, staleDone);
    current = false;
    stale.handleInput("\r");
    expect(staleDone).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("does not open a custom terminal component in RPC or headless mode", async () => {
    const custom = vi.fn();
    for (const ctx of [{ mode: "rpc", hasUI: true, ui: { custom } }, { mode: "tui", hasUI: false, ui: { custom } }]) {
      expect(await openPtbPalette(ctx as any, { items, isCurrent: () => true })).toBeUndefined();
    }
    expect(custom).not.toHaveBeenCalled();
  });

  it("bounds a long Team selection at 80x24 without hiding its cancel route", () => {
    const many: PtbPaletteItem[] = Array.from({ length: 18 }, (_, index) => ({
      id: `team-${index}`, tab: "Team", label: `Team control ${index}`,
      description: `Describe Team control ${index}. `.repeat(15), currentValue: "inherited / default",
    }));
    const component = createPtbPaletteComponent({ items: many, isCurrent: () => true, initialTab: "Team" }, {
      requestRender() {}, terminalRows: () => 24,
    }, theme, vi.fn());
    const lines = component.render(80);
    expect(lines.length).toBeLessThanOrEqual(24);
    expect(lines.join("\n")).toContain("Esc cancel");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });
});
