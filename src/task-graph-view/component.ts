import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { layoutTaskGraph, renderTaskGraphViewport, type TaskGraphCanvas, type TaskGraphDirection } from "./layout";
import {
  TASK_GRAPH_LIMITS,
  parseTaskGraphViewSource,
  type TaskGraphRecentLimit,
  type TaskGraphStateFilter,
  type TaskGraphViewSource,
} from "./source";

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const LIMIT_SEQUENCE: readonly TaskGraphRecentLimit[] = [...TASK_GRAPH_LIMITS, "all"];
const FILTER_SEQUENCE: readonly TaskGraphStateFilter[] = ["all", "actionable", "nonterminal", "failed"];

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(1, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export interface TaskGraphPaneComponentOptions {
  source: TaskGraphViewSource;
  initialLimit: TaskGraphRecentLimit;
  terminalRows: () => number;
  requestRender: () => void;
}

/** A pure read-only Pi TUI component over a validated graph projection. */
export class TaskGraphPaneComponent implements Component {
  private source: TaskGraphViewSource;
  private limit: TaskGraphRecentLimit;
  private stateFilter: TaskGraphStateFilter = "all";
  private direction: TaskGraphDirection = "TB";
  private x = 0;
  private y = 0;
  private islandIndex = 0;
  private canvas?: TaskGraphCanvas;
  private canvasKey?: string;
  private readonly terminalRows: () => number;
  private readonly request: () => void;
  private lastWidth = 80;

  constructor(options: TaskGraphPaneComponentOptions) {
    this.source = parseTaskGraphViewSource(options.source);
    this.limit = options.initialLimit;
    this.terminalRows = options.terminalRows;
    this.request = options.requestRender;
  }

  setSource(source: TaskGraphViewSource): void {
    const validated = parseTaskGraphViewSource(source);
    if (validated.source_revision === this.source.source_revision) return;
    this.source = validated;
    this.invalidate();
    this.request();
  }

  invalidate(): void {
    this.canvas = undefined;
    this.canvasKey = undefined;
  }

  private viewportHeight(): number {
    return Math.max(1, Math.max(4, this.terminalRows()) - 3);
  }

  private getCanvas(width: number): TaskGraphCanvas {
    const nodeWidth = Math.max(20, Math.min(36, width - 4));
    const packWidth = Math.max(80, Math.min(320, width * 3));
    const key = `${this.source.source_revision}\u0000${this.limit}\u0000${this.stateFilter}\u0000${this.direction}\u0000${nodeWidth}\u0000${packWidth}`;
    if (!this.canvas || this.canvasKey !== key) {
      this.canvas = layoutTaskGraph(this.source, this.limit, {
        direction: this.direction,
        nodeWidth,
        packWidth,
        stateFilter: this.stateFilter,
      });
      this.canvasKey = key;
      this.islandIndex = Math.min(this.islandIndex, Math.max(0, this.canvas.islands.length - 1));
      this.clampViewport(width);
    }
    return this.canvas;
  }

  private clampViewport(width: number): void {
    if (!this.canvas) return;
    this.x = Math.max(0, Math.min(this.x, Math.max(0, this.canvas.width - width)));
    this.y = Math.max(0, Math.min(this.y, Math.max(0, this.canvas.height - this.viewportHeight())));
  }

  private focusIsland(index: number, width: number): void {
    const canvas = this.getCanvas(width);
    if (!canvas.islands.length) return;
    this.islandIndex = (index + canvas.islands.length) % canvas.islands.length;
    const island = canvas.islands[this.islandIndex];
    this.x = Math.max(0, Math.round(island.x + island.width / 2 - width / 2));
    this.y = Math.max(0, Math.round(island.y + island.height / 2 - this.viewportHeight() / 2));
    this.clampViewport(width);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    this.lastWidth = safeWidth;
    const canvas = this.getCanvas(safeWidth);
    const filter = this.limit === "all" ? "all" : `recent ${this.limit}`;
    const omissionsVisible = canvas.visible.omittedNodeCount > 0 || canvas.visible.boundaryEdgeCount > 0;
    const omitted = omissionsVisible
      ? ` · −${canvas.visible.recencyOmittedNodeCount} recent/−${canvas.visible.filterOmittedNodeCount} filtered/−${canvas.visible.boundaryEdgeCount} boundary`
      : "";
    const authority = this.source.authority === "graph_control" ? "graph control" : "legacy cards (closed ≠ success)";
    const island = canvas.islands.length ? `${this.islandIndex + 1}/${canvas.islands.length}` : "0/0";
    const header = fit(`Task graph · ${this.source.team_name} · ${canvas.visible.nodes.length}/${this.source.nodes.length} · ${filter} · ${this.stateFilter}${omitted}`, safeWidth);
    const freshness = fit(`${authority} · rev ${this.source.source_revision} · ${this.direction} · island ${island} · view ${this.x},${this.y}`, safeWidth);
    const footer = fit("arrows/hjkl pan · [/ ] island · f recent · s state · r rotate · Home reset", safeWidth);
    return [
      `${BOLD}${header}${RESET}`,
      `${DIM}${freshness}${RESET}`,
      ...renderTaskGraphViewport({ canvas, x: this.x, y: this.y, width: safeWidth, height: this.viewportHeight() }),
      `${DIM}${footer}${RESET}`,
    ];
  }

  handleInput(data: string): void {
    const width = this.lastWidth;
    let changed = true;
    if (matchesKey(data, Key.left) || matchesKey(data, "h")) this.x -= 3;
    else if (matchesKey(data, Key.right) || matchesKey(data, "l")) this.x += 3;
    else if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.y -= 2;
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.y += 2;
    else if (matchesKey(data, Key.home)) { this.x = 0; this.y = 0; this.islandIndex = 0; }
    else if (matchesKey(data, "[")) this.focusIsland(this.islandIndex - 1, width);
    else if (matchesKey(data, "]")) this.focusIsland(this.islandIndex + 1, width);
    else if (matchesKey(data, "f")) {
      const index = LIMIT_SEQUENCE.indexOf(this.limit);
      this.limit = LIMIT_SEQUENCE[(index + 1) % LIMIT_SEQUENCE.length];
      this.invalidate();
      this.x = 0;
      this.y = 0;
      this.islandIndex = 0;
    } else if (matchesKey(data, "s")) {
      const index = FILTER_SEQUENCE.indexOf(this.stateFilter);
      this.stateFilter = FILTER_SEQUENCE[(index + 1) % FILTER_SEQUENCE.length];
      this.invalidate();
      this.x = 0;
      this.y = 0;
      this.islandIndex = 0;
    } else if (matchesKey(data, "r")) {
      this.direction = this.direction === "TB" ? "LR" : "TB";
      this.invalidate();
      this.x = 0;
      this.y = 0;
      this.islandIndex = 0;
    } else changed = false;
    if (changed) {
      this.getCanvas(width);
      this.clampViewport(width);
      this.request();
    }
  }
}
