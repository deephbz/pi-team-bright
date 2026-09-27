import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { TaskGraphPaneComponent } from "./component";
import type { TaskDagIslandsGalleryConfig } from "./gallery-config";

export type TaskGraphGalleryView = "dag" | "timeline";

export interface TaskGraphGalleryOptions {
  rows: () => number;
  requestRender: () => void;
  color: boolean;
  width: number;
  view?: TaskGraphGalleryView;
}

const stripAnsi = (line: string): string => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");

/** Review the production graph pane against a synthetic, fixed-clock source. */
export class TaskDagGalleryComponent implements Component {
  constructor(private readonly graph: TaskGraphPaneComponent, private readonly color: boolean, private readonly reviewNow: string) {}

  invalidate(): void { this.graph.invalidate(); }
  handleInput(data: string): void { this.graph.handleInput(data); }
  render(width: number): string[] {
    const footer = truncateToWidth(`Mock fixture · fixed review clock ${this.reviewNow} · q quit`, width);
    const lines = [...this.graph.render(width), this.color ? `\u001b[2m${footer}\u001b[0m` : footer];
    return this.color ? lines : lines.map(stripAnsi);
  }
}

export function createTaskDagIslandsGalleryComponent(
  config: TaskDagIslandsGalleryConfig,
  options: TaskGraphGalleryOptions,
): TaskDagGalleryComponent {
  const graph = new TaskGraphPaneComponent({
    source: config.source,
    initialLimit: config.initial_limit,
    initialDirection: config.initial_direction,
    terminalRows: () => Math.max(6, options.rows() - 1),
    requestRender: options.requestRender,
    now: () => Date.parse(config.review_now),
    color: options.color,
  });
  graph.render(options.width);
  if (options.view === "timeline") graph.handleInput("v");
  if (config.start_mode === "select") graph.handleInput("\t");
  if (config.expand_selected) graph.handleInput("\r");
  return new TaskDagGalleryComponent(graph, options.color, config.review_now);
}
