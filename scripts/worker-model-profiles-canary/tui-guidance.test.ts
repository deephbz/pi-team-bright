import { describe, expect, it } from "vitest";
import { projectionLines } from "../../src/model-tool-contract/tui-message-projection";
import { tuiMessageGallery } from "../../src/model-tool-contract/tui-message-gallery";

/** Check the human-only route to the shipped settings example. */
describe("Worker model role TUI guidance", () => {
  const scenarios = () => tuiMessageGallery()
    .filter((scenario) => scenario.message.type === "ensure_worker");

  it("covers success and failure ensure_worker variants", () => {
    const values = scenarios();
    expect(values.some((scenario) => scenario.resultKind === "worker_ensured")).toBe(true);
    expect(values.some((scenario) => scenario.resultKind === "refused")).toBe(true);
    expect(values.some((scenario) => scenario.resultKind === "unavailable")).toBe(true);
  });

  it("points invalid selections to one shipped example without embedding settings JSON", () => {
    const values = scenarios();
    for (const scenario of values) {
      const collapsed = projectionLines(scenario.message, { expanded: false }).join("\n");
      const expanded = projectionLines(scenario.message, { expanded: true }).join("\n");
      expect(collapsed, scenario.id).not.toContain('"model_roles": {');
      expect(expanded, scenario.id).not.toContain('"model_roles": {');
      if (scenario.resultKind === "refused" && scenario.message.detail?.reason === "invalid_model_role") {
        expect(collapsed, scenario.id).toContain("docs/examples/pi-team-bright.settings.json");
        expect(expanded, scenario.id).toContain("docs/examples/pi-team-bright.settings.json");
      }
    }
  });

  it("does not place human guidance in model-facing JSON", () => {
    for (const scenario of scenarios()) {
      const model = JSON.stringify(scenario.message.detail);
      expect(model, scenario.id).not.toMatch(/docs\/examples\/pi-team-bright\.settings\.json|"model_roles"\s*:/i);
    }
  });
});
