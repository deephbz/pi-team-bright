import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { layoutTaskGraph } from "./layout";
import {
  DEFAULT_TASK_DAG_ISLANDS_GALLERY_CONFIG,
  loadTaskDagIslandsGalleryConfig,
  parseTaskDagIslandsGalleryConfig,
} from "./gallery-config";

const GRAPH_CONTROL_STATES = [
  "blocked",
  "cancelled",
  "dependency_waiting",
  "goal_achieved",
  "goal_failed",
  "in_progress",
  "ready",
];

describe("Task DAG islands gallery config", () => {
  it("loads one clear sentinel fixture with every graph-control Task state", () => {
    const config = loadTaskDagIslandsGalleryConfig();
    expect(config.source.team_name).toBe("task-dag-islands-gallery");
    expect([...new Set(config.source.nodes.map((node) => node.state))].sort()).toEqual(GRAPH_CONTROL_STATES);
    expect(config.source.nodes.map((node) => node.id).sort()).toEqual([
      "dag1-task1", "dag1-task2", "dag1-task3", "dag1-task4",
      "dag2-task1", "dag2-task2", "dag3-task1",
    ]);
    for (const [index, node] of [...config.source.nodes].sort((left, right) => left.id.localeCompare(right.id)).entries()) {
      expect(node.assignee).toBe(`worker${index + 1}`);
      expect(node.goal).toContain(`goal${index + 1}:`);
      expect(node.current_context).toContain(`context${index + 1}:`);
    }
    expect(new Set(config.source.edges.map((edge) => edge.kind))).toEqual(new Set(["goal_achieved", "goal_failed"]));
    expect(layoutTaskGraph(config.source, "all", { packWidth: 160 }).islands).toHaveLength(3);
  });

  it("accepts a different checked config without code changes", () => {
    const raw = JSON.parse(fs.readFileSync(DEFAULT_TASK_DAG_ISLANDS_GALLERY_CONFIG, "utf8"));
    raw.name = "alternate review";
    raw.source.team_name = "alternate-dag-gallery";
    raw.source.source_revision = "alternate-revision";
    const parsed = parseTaskDagIslandsGalleryConfig(raw);
    expect(parsed.name).toBe("alternate review");
    expect(parsed.source.team_name).toBe("alternate-dag-gallery");
  });

  it("rejects unsupported gallery fields before rendering", () => {
    const raw = JSON.parse(fs.readFileSync(DEFAULT_TASK_DAG_ISLANDS_GALLERY_CONFIG, "utf8"));
    expect(() => parseTaskDagIslandsGalleryConfig({ ...raw, hidden_override: true })).toThrow(/unsupported field/);
  });
});
