import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import {
  findDirectionalTaskGraphNode,
  formatTaskGraphDuration,
  layoutTaskGraph,
  renderTaskGraphViewport,
  taskGraphAttemptLabel,
  type TaskGraphCanvas,
  type TaskGraphDirection,
  type TaskGraphNavigationDirection,
  type TaskGraphNodeBox,
} from "./layout";
import {
  TASK_GRAPH_LIMITS,
  parseTaskGraphViewSource,
  type TaskGraphRecentLimit,
  type TaskGraphStateFilter,
  type TaskGraphViewNode,
  type TaskGraphViewSource,
} from "./source";

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const LIMIT_SEQUENCE: readonly TaskGraphRecentLimit[] = [...TASK_GRAPH_LIMITS, "all"];
const FILTER_SEQUENCE: readonly TaskGraphStateFilter[] = ["all", "actionable", "nonterminal", "failed"];
const HUD_ROWS = 3;
const FOOTER_ROWS = 1;

type TaskGraphInteractionMode = "pan" | "select";

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(1, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function exactTime(value: string | undefined): string {
  return value ? value.replace("T", " ").replace(".000Z", "Z") : "unknown";
}

function terminalState(node: TaskGraphViewNode): boolean {
  return ["goal_achieved", "goal_failed", "cancelled", "legacy_completed"].includes(node.state);
}

function elapsed(node: TaskGraphViewNode, now: number): string {
  if (!node.first_activity_at || !node.last_activity_at) return "unknown";
  const end = terminalState(node) ? Date.parse(node.last_activity_at) : now;
  return formatTaskGraphDuration(Math.max(0, end - Date.parse(node.first_activity_at)));
}

function detailField(label: string, value: string, width: number): string[] {
  const prefix = `${label}: `;
  const indent = " ".repeat(visibleWidth(prefix));
  const wrapped = wrapTextWithAnsi(`${prefix}${value}`, Math.max(1, width));
  return wrapped.map((line, index) => fit(index === 0 ? line : `${indent}${line.trimStart()}`, width));
}

export interface TaskGraphPaneComponentOptions {
  source: TaskGraphViewSource;
  initialLimit: TaskGraphRecentLimit;
  initialDirection?: TaskGraphDirection;
  terminalRows: () => number;
  requestRender: () => void;
  now?: () => number;
  /** Disable ANSI only for deterministic renderer tests and text artifacts. */
  color?: boolean;
}

/** A read-only Pi TUI projection with separate pan and node-selection modes. */
export class TaskGraphPaneComponent implements Component {
  private source: TaskGraphViewSource;
  private limit: TaskGraphRecentLimit;
  private stateFilter: TaskGraphStateFilter = "all";
  private direction: TaskGraphDirection = "TB";
  private mode: TaskGraphInteractionMode = "pan";
  private selectedTaskId?: string;
  private expandedTaskId?: string;
  private x = 0;
  private y = 0;
  private islandIndex = 0;
  private canvas?: TaskGraphCanvas;
  private canvasKey?: string;
  private readonly terminalRows: () => number;
  private readonly request: () => void;
  private readonly now: () => number;
  private readonly color: boolean;
  private lastWidth = 80;

  constructor(options: TaskGraphPaneComponentOptions) {
    this.source = parseTaskGraphViewSource(options.source);
    this.limit = options.initialLimit;
    this.direction = options.initialDirection ?? "TB";
    this.terminalRows = options.terminalRows;
    this.request = options.requestRender;
    this.now = options.now ?? Date.now;
    this.color = options.color !== false;
  }

  setSource(source: TaskGraphViewSource): void {
    const validated = parseTaskGraphViewSource(source);
    if (validated.source_revision === this.source.source_revision) return;
    this.source = validated;
    if (this.selectedTaskId && !validated.nodes.some((node) => node.id === this.selectedTaskId)) {
      this.selectedTaskId = undefined;
      this.expandedTaskId = undefined;
    }
    this.invalidate();
    this.request();
  }

  invalidate(): void {
    this.canvas = undefined;
    this.canvasKey = undefined;
  }

  private style(style: string, text: string): string {
    return this.color ? `${style}${text}${RESET}` : text;
  }

  private detailLines(width: number): string[] {
    if (!this.expandedTaskId || this.mode !== "select") return [];
    const node = this.source.nodes.find((candidate) => candidate.id === this.expandedTaskId);
    if (!node) return [];
    const now = this.now();
    const timing = `first observed ${exactTime(node.first_activity_at)} · last update ${exactTime(node.last_activity_at)} · elapsed ${elapsed(node, now)}`;
    const waiting = node.waiting_on_task_ids.length ? ` · waiting on ${node.waiting_on_task_ids.join(", ")}` : "";
    const lines = [
      fit(`Details: [${node.state}] ${node.id}@${node.assignee ?? "unassigned"} · ${node.title}`, width),
      fit(`Timing: ${timing}`, width),
      fit(`Attempt: ${taskGraphAttemptLabel(node)}${waiting}`, width),
      ...detailField("Goal", node.goal ?? "unavailable", width),
      ...detailField("Context", node.current_context ?? "unavailable", width),
    ];
    const available = Math.max(1, this.terminalRows() - HUD_ROWS - FOOTER_ROWS - 4);
    return lines.slice(0, Math.min(8, available));
  }

  private viewportHeight(width = this.lastWidth): number {
    return Math.max(1, Math.max(6, this.terminalRows()) - HUD_ROWS - FOOTER_ROWS - this.detailLines(width).length);
  }

  private getCanvas(width: number): TaskGraphCanvas {
    const nodeWidth = Math.max(28, Math.min(42, width - 4));
    const packWidth = Math.max(80, Math.min(320, width * 3));
    const timeBucket = Math.floor(this.now() / 60_000);
    const key = `${this.source.source_revision}\u0000${this.limit}\u0000${this.stateFilter}\u0000${this.direction}\u0000${nodeWidth}\u0000${packWidth}\u0000${timeBucket}`;
    if (!this.canvas || this.canvasKey !== key) {
      this.canvas = layoutTaskGraph(this.source, this.limit, {
        direction: this.direction,
        nodeWidth,
        packWidth,
        stateFilter: this.stateFilter,
        now: this.now(),
      });
      this.canvasKey = key;
      this.islandIndex = Math.min(this.islandIndex, Math.max(0, this.canvas.islands.length - 1));
      if (this.selectedTaskId && !this.canvas.nodes.some((box) => box.node.id === this.selectedTaskId)) {
        this.selectedTaskId = undefined;
        this.expandedTaskId = undefined;
      }
      this.clampViewport(width);
    }
    return this.canvas;
  }

  private clampViewport(width: number): void {
    if (!this.canvas) return;
    this.x = Math.max(0, Math.min(this.x, Math.max(0, this.canvas.width - width)));
    this.y = Math.max(0, Math.min(this.y, Math.max(0, this.canvas.height - this.viewportHeight(width))));
  }

  private focusBox(box: TaskGraphNodeBox, width: number): void {
    const height = this.viewportHeight(width);
    if (box.x < this.x + 1) this.x = Math.max(0, box.x - 1);
    else if (box.x + box.width > this.x + width - 1) this.x = box.x + box.width - width + 1;
    if (box.y < this.y + 1) this.y = Math.max(0, box.y - 1);
    else if (box.y + box.height > this.y + height - 1) this.y = box.y + box.height - height + 1;
    this.islandIndex = box.islandIndex;
    this.clampViewport(width);
  }

  private initialSelection(width: number): TaskGraphNodeBox | undefined {
    const canvas = this.getCanvas(width);
    const centerX = this.x + width / 2;
    const centerY = this.y + this.viewportHeight(width) / 2;
    return [...canvas.nodes].sort((left, right) => {
      const leftDistance = Math.hypot(left.centerX - centerX, left.centerY - centerY);
      const rightDistance = Math.hypot(right.centerX - centerX, right.centerY - centerY);
      return leftDistance - rightDistance || left.node.id.localeCompare(right.node.id);
    })[0];
  }

  private focusIsland(index: number, width: number): void {
    const canvas = this.getCanvas(width);
    if (!canvas.islands.length) return;
    this.islandIndex = (index + canvas.islands.length) % canvas.islands.length;
    const island = canvas.islands[this.islandIndex];
    if (this.mode === "select") {
      const box = canvas.nodes.find((candidate) => candidate.islandIndex === this.islandIndex);
      if (box) {
        this.selectedTaskId = box.node.id;
        this.expandedTaskId = undefined;
        this.focusBox(box, width);
      }
      return;
    }
    this.x = Math.max(0, Math.round(island.x + island.width / 2 - width / 2));
    this.y = Math.max(0, Math.round(island.y + island.height / 2 - this.viewportHeight(width) / 2));
    this.clampViewport(width);
  }

  private switchMode(width: number): void {
    if (this.mode === "pan") {
      this.mode = "select";
      const selected = this.selectedTaskId
        ? this.getCanvas(width).nodes.find((box) => box.node.id === this.selectedTaskId)
        : this.initialSelection(width);
      if (selected) {
        this.selectedTaskId = selected.node.id;
        this.focusBox(selected, width);
      }
    } else {
      this.mode = "pan";
      this.expandedTaskId = undefined;
    }
  }

  private moveSelection(direction: TaskGraphNavigationDirection, width: number): void {
    const canvas = this.getCanvas(width);
    const currentId = this.selectedTaskId ?? this.initialSelection(width)?.node.id;
    if (!currentId) return;
    this.selectedTaskId = currentId;
    const next = findDirectionalTaskGraphNode(canvas, currentId, direction);
    if (!next) return;
    this.selectedTaskId = next.node.id;
    this.expandedTaskId = undefined;
    this.focusBox(next, width);
  }

  private resetView(width: number): void {
    this.x = 0;
    this.y = 0;
    this.islandIndex = 0;
    this.expandedTaskId = undefined;
    if (this.mode === "select") {
      const first = this.getCanvas(width).nodes[0];
      this.selectedTaskId = first?.node.id;
      if (first) this.focusBox(first, width);
    }
  }

  private sourceUpdatedAt(): string {
    const values = this.source.nodes.flatMap((node) => node.last_activity_at ? [node.last_activity_at] : []);
    return exactTime(values.sort().at(-1));
  }

  private legend(width: number): string {
    const full = "Legend: ◷ wait · ● ready · ▶ active · ■ blocked · ✓ achieved · ✕ failed · ⊘ cancelled · ━ success · ╌ failure";
    const compact = "Legend: ◷ wait ● ready ▶ active ■ block ✓ done ✕ fail ⊘ cancel | ━ success ╌ failure";
    return fit(width >= 100 ? full : compact, width);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    this.lastWidth = safeWidth;
    const canvas = this.getCanvas(safeWidth);
    const filter = this.limit === "all" ? "all tasks" : `recent ${this.limit}`;
    const authority = this.source.authority === "graph_control" ? "graph control" : "legacy cards";
    const island = canvas.islands.length ? `${this.islandIndex + 1}/${canvas.islands.length}` : "0/0";
    const hiddenTasks = canvas.visible.recencyOmittedNodeCount + canvas.visible.filterOmittedNodeCount;
    const header = fit(`Task graph: ${this.source.team_name} · ${authority} · rev ${this.source.source_revision} · updated ${this.sourceUpdatedAt()}`, safeWidth);
    const view = fit(`View: ${this.mode.toUpperCase()} · ${canvas.visible.nodes.length}/${this.source.nodes.length} tasks · ${filter} · ${this.stateFilter} states · ${this.direction} · island ${island} · offset ${this.x},${this.y} · hidden ${hiddenTasks} tasks/${canvas.visible.boundaryEdgeCount} edges`, safeWidth);
    const details = this.detailLines(safeWidth).map((line, index) => this.style(index === 0 ? BOLD : DIM, line));
    const footerText = this.mode === "pan"
      ? "Shortcuts: Tab select · hjkl/arrows pan · [/] island · f recent · s state · r rotate · Home reset"
      : "Shortcuts: Tab/Esc pan · hjkl/arrows select · Enter details · [/] island · f recent · s state · r rotate · Home reset";
    return [
      this.style(BOLD, header),
      this.style(DIM, view),
      this.style(DIM, this.legend(safeWidth)),
      ...details,
      ...renderTaskGraphViewport({
        canvas,
        x: this.x,
        y: this.y,
        width: safeWidth,
        height: this.viewportHeight(safeWidth),
        color: this.color,
        ...(this.mode === "select" && this.selectedTaskId ? { selectedTaskId: this.selectedTaskId } : {}),
      }),
      this.style(DIM, fit(footerText, safeWidth)),
    ];
  }

  handleInput(data: string): void {
    const width = this.lastWidth;
    let changed = true;
    if (matchesKey(data, Key.tab)) this.switchMode(width);
    else if (this.mode === "select" && matchesKey(data, Key.escape)) this.switchMode(width);
    else if (matchesKey(data, "[")) this.focusIsland(this.islandIndex - 1, width);
    else if (matchesKey(data, "]")) this.focusIsland(this.islandIndex + 1, width);
    else if (matchesKey(data, Key.home)) this.resetView(width);
    else if (this.mode === "select" && (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || matchesKey(data, "e"))) {
      if (this.selectedTaskId) this.expandedTaskId = this.expandedTaskId === this.selectedTaskId ? undefined : this.selectedTaskId;
    } else if (this.mode === "select" && (matchesKey(data, Key.left) || matchesKey(data, "h"))) this.moveSelection("left", width);
    else if (this.mode === "select" && (matchesKey(data, Key.right) || matchesKey(data, "l"))) this.moveSelection("right", width);
    else if (this.mode === "select" && (matchesKey(data, Key.up) || matchesKey(data, "k"))) this.moveSelection("up", width);
    else if (this.mode === "select" && (matchesKey(data, Key.down) || matchesKey(data, "j"))) this.moveSelection("down", width);
    else if (this.mode === "pan" && (matchesKey(data, Key.left) || matchesKey(data, "h"))) this.x -= 3;
    else if (this.mode === "pan" && (matchesKey(data, Key.right) || matchesKey(data, "l"))) this.x += 3;
    else if (this.mode === "pan" && (matchesKey(data, Key.up) || matchesKey(data, "k"))) this.y -= 2;
    else if (this.mode === "pan" && (matchesKey(data, Key.down) || matchesKey(data, "j"))) this.y += 2;
    else if (matchesKey(data, "f")) {
      const index = LIMIT_SEQUENCE.indexOf(this.limit);
      this.limit = LIMIT_SEQUENCE[(index + 1) % LIMIT_SEQUENCE.length];
      this.invalidate();
      this.resetView(width);
    } else if (matchesKey(data, "s")) {
      const index = FILTER_SEQUENCE.indexOf(this.stateFilter);
      this.stateFilter = FILTER_SEQUENCE[(index + 1) % FILTER_SEQUENCE.length];
      this.invalidate();
      this.resetView(width);
    } else if (matchesKey(data, "r")) {
      this.direction = this.direction === "TB" ? "LR" : "TB";
      this.invalidate();
      this.resetView(width);
    } else changed = false;
    if (changed) {
      this.getCanvas(width);
      this.clampViewport(width);
      this.request();
    }
  }
}
