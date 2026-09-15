import { describe, expect, it } from "vitest";
import { projectionLines } from "../../src/model-tool-contract/tui-message-projection";
import { tuiMessageGallery } from "../../src/model-tool-contract/tui-message-gallery";

/**
 * Independent ADR0014 human-projection check.
 *
 * Builder-owned TUI tests prove renderer mechanics. This check proves the
 * profile-specific audience contract: collapsed guidance stays short and the
 * expanded view carries one usable settings example.
 */
describe("ADR0014 Worker profile TUI guidance", () => {
  const scenarios = () => tuiMessageGallery()
    .filter((scenario) => scenario.message.type === "ensure_worker");

  it("covers success and failure ensure_worker variants", () => {
    const values = scenarios();
    expect(values.some((scenario) => scenario.resultKind === "worker_ensured")).toBe(true);
    expect(values.some((scenario) => scenario.resultKind === "refused")).toBe(true);
    expect(values.some((scenario) => scenario.resultKind === "unavailable")).toBe(true);
  });

  it("keeps settings guidance collapsed and expands one usable example", () => {
    const values = scenarios();
    for (const scenario of values) {
      const collapsed = projectionLines(scenario.message, { expanded: false }).join("\n");
      const expanded = projectionLines(scenario.message, { expanded: true }).join("\n");
      expect(collapsed, scenario.id).toMatch(/settings/i);
      expect(collapsed, scenario.id).not.toContain("model_profiles");
      expect(expanded, scenario.id).toContain("model_profiles");
      expect(expanded, scenario.id).toContain("alias");
      expect(expanded, scenario.id).toContain("provider");
      expect(expanded, scenario.id).toContain("thinking");
      expect(expanded, scenario.id).toContain("use");
    }
  });

  it("does not place human guidance in model-facing JSON", () => {
    for (const scenario of scenarios()) {
      const model = JSON.stringify(scenario.message.detail);
      expect(model, scenario.id).not.toMatch(/add aliases|"model_profiles"\s*:|settings example/i);
    }
  });
});
