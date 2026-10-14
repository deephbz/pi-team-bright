import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface Inventory {
  schema: string;
  productionChanges: boolean;
  stages: Array<{ id: string; authority: string; evidence: string }>;
  scenarios: Array<{
    id: string;
    stages: string[];
    primaryAnchor: string;
    supportingAnchors: Array<{ path: string; proofLimit: string }>;
    result: string;
  }>;
  realRuntimeGaps: string[];
}

const inventory = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), "src/utils/causal-path.inventory.json"),
  "utf8",
)) as Inventory;

describe("causal-path characterization inventory", () => {
  it("keeps the Task-to-observation path and its outside-in anchors machine-operable", () => {
    expect(inventory.schema).toBe("pi-teams-causal-path-characterization/1");
    expect(inventory.productionChanges).toBe(false);
    expect(inventory.stages.map((stage) => stage.id)).toEqual([
      "assigned_task",
      "exact_session_presentation",
      "successful_turn_acknowledgement",
      "leader_observation",
    ]);
    const ids = inventory.scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      "happy_path", "cancellation", "restart", "duplicate", "stale_membership",
      "delivery_failure", "timeout", "branch_safe_observation",
    ]));
    for (const scenario of inventory.scenarios) {
      expect(scenario.stages.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(process.cwd(), scenario.primaryAnchor))).toBe(true);
      for (const anchor of scenario.supportingAnchors) {
        expect(fs.existsSync(path.join(process.cwd(), anchor.path))).toBe(true);
        expect(anchor.proofLimit.length).toBeGreaterThan(0);
      }
    }
    expect(inventory.realRuntimeGaps.length).toBeGreaterThan(0);
  });
});
