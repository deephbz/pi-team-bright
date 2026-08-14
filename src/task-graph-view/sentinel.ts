import { TaskGraphPaneComponent } from "./component";
import { loadTaskDagIslandsGalleryConfig } from "./gallery-config";
import type { TaskGraphDirection } from "./layout";
import type { TaskGraphViewSource } from "./source";

export const TASK_GRAPH_SENTINEL_WIDTH = 120;
export const TASK_GRAPH_LR_SENTINEL_WIDTH = 180;
export const TASK_GRAPH_SENTINEL_ROWS = 42;

/** The checked-in gallery config is the single machine fixture for render review. */
export function taskGraphSentinelSource(): TaskGraphViewSource {
  return loadTaskDagIslandsGalleryConfig().source;
}

/** Render the whole TUI component, not only Dagre placement or cell clipping. */
export function renderTaskGraphSentinel(
  direction: TaskGraphDirection = "TB",
  width = direction === "LR" ? TASK_GRAPH_LR_SENTINEL_WIDTH : TASK_GRAPH_SENTINEL_WIDTH,
): string {
  const config = loadTaskDagIslandsGalleryConfig();
  const component = new TaskGraphPaneComponent({
    source: config.source,
    initialLimit: config.initial_limit,
    initialDirection: direction,
    terminalRows: () => TASK_GRAPH_SENTINEL_ROWS,
    requestRender: () => undefined,
    now: () => Date.parse(config.review_now),
    color: false,
  });
  component.render(width);
  if (config.start_mode === "select") component.handleInput("\t");
  if (config.expand_selected) component.handleInput("\r");
  return `${component.render(width).map((line) => line.trimEnd()).join("\n")}\n`;
}
