import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  selectVisibleTaskGraph,
  type TaskGraphRecentLimit,
  type TaskGraphStateFilter,
  type TaskGraphViewNode,
  type TaskGraphViewSource,
  type TimelineAttempt,
  type VisibleTaskGraph,
} from "./source";

/** Render Task and Attempt state spans on a wall-clock axis. No span represents effort. */
export interface TaskTimelineLayout {
  visible: VisibleTaskGraph;
  rows: Array<{ taskId: string; node: TaskGraphViewNode; attempt?: TimelineAttempt }>;
  taskRows: ReadonlyMap<string, number>;
  labelWidth: number;
  plotWidth: number;
  origin?: number;
  scaleMs: number;
  maxX: number;
  width: number;
}

function fit(value: string, width: number): string {
  if (width <= 0) return "";
  const text = truncateToWidth(value, width, "…").replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function stateLabel(node: TaskGraphViewNode): string {
  return node.state === "dependency_waiting" ? "waiting"
    : node.state === "goal_achieved" ? "achieved"
      : node.state === "legacy_completed" ? "completed"
        : node.state.replaceAll("_", " ");
}

function attemptLabel(attempt: TimelineAttempt, now: number): string {
  const result = attempt.outcome === "goal_achieved" ? " ✓"
    : attempt.outcome === "goal_failed" ? " ✕" : "";
  const start = validTime(attempt.segments[0]?.started_at);
  const end = validTime(attempt.segments.at(-1)?.ended_at) ?? now;
  const seconds = start === undefined ? undefined : Math.floor((end - start) / 1_000);
  const duration = attempt.timing !== "recorded" || seconds === undefined || seconds < 0 ? ""
    : seconds < 60 ? ` ${seconds}s` : seconds < 3_600 ? ` ${Math.floor(seconds / 60)}m${seconds % 60}s`
      : ` ${Math.floor(seconds / 3_600)}h${Math.floor(seconds % 3_600 / 60)}m`;
  return `  ↳ #${attempt.ordinal} ${attempt.state}${result}${duration}`;
}

function validTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

export function layoutTaskTimeline(
  source: TaskGraphViewSource,
  limit: TaskGraphRecentLimit,
  stateFilter: TaskGraphStateFilter,
  width: number,
  now: number,
  zoom = 1,
): TaskTimelineLayout {
  const safeWidth = Math.max(1, Math.floor(width));
  const selected = selectVisibleTaskGraph(source, limit, stateFilter);
  const firstTime = (node: TaskGraphViewNode) => Math.min(...(node.timeline_attempts ?? [])
    .filter(attempt => attempt.timing === "recorded")
    .map(attempt => validTime(attempt.segments[0]?.started_at) ?? Infinity));
  const visible = { ...selected, nodes: [...selected.nodes].sort((a, b) => firstTime(a) - firstTime(b) || a.id.localeCompare(b.id)) };
  const labelWidth = Math.min(34, Math.max(0, safeWidth - 4), Math.max(8, Math.floor(safeWidth * 0.4)));
  const plotWidth = Math.max(1, safeWidth - labelWidth - 1);
  const rows: TaskTimelineLayout["rows"] = [];
  const taskRows = new Map<string, number>();
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const node of visible.nodes) {
    taskRows.set(node.id, rows.length);
    rows.push({ taskId: node.id, node });
    for (const attempt of node.timeline_attempts ?? []) {
      rows.push({ taskId: node.id, node, attempt });
      if (attempt.timing !== "recorded") continue;
      for (const segment of attempt.segments) {
        const left = validTime(segment.started_at);
        const open = attempt.current && (attempt.state === "in_progress" || attempt.state === "blocked");
        const right = validTime(segment.ended_at) ?? (open ? now : undefined);
        if (left === undefined || right === undefined || right < left) continue;
        start = Math.min(start, left);
        end = Math.max(end, right);
      }
    }
  }
  const origin = Number.isFinite(start) ? start : undefined;
  const span = origin === undefined ? 0 : Math.max(1_000, end - origin);
  const scaleMs = Math.max(1_000, Math.ceil(span / Math.max(1, plotWidth * Math.max(1, zoom) - 1) / 1_000) * 1_000);
  const columns = origin === undefined ? plotWidth : Math.max(plotWidth, Math.ceil(span / scaleMs) + 1);
  return { visible, rows, taskRows, labelWidth, plotWidth, origin, scaleMs, maxX: Math.max(0, columns - plotWidth), width: safeWidth };
}

function axis(layout: TaskTimelineLayout, x: number): string {
  const marks = Array.from({ length: layout.plotWidth }, () => "·");
  if (layout.origin !== undefined) {
    for (let column = 0; column < layout.plotWidth; column += 15) {
      const offsetSeconds = Math.floor((x + column) * layout.scaleMs / 1_000);
      const label = offsetSeconds < 60 ? `+${offsetSeconds}s`
        : offsetSeconds < 3_600 ? `+${Math.floor(offsetSeconds / 60)}m${offsetSeconds % 60}s`
          : `+${Math.floor(offsetSeconds / 3_600)}h${Math.floor(offsetSeconds % 3_600 / 60)}m`;
      for (let index = 0; index < label.length && column + index < marks.length; index++) marks[column + index] = label[index];
    }
  }
  return fit("Elapsed", layout.labelWidth) + " " + marks.join("");
}

function lane(layout: TaskTimelineLayout, rowIndex: number, x: number, now: number): string {
  const row = layout.rows[rowIndex];
  if (!row) return " ".repeat(layout.width);
  const label = row.attempt
    ? attemptLabel(row.attempt, now)
    : `▸ ${row.node.id} [${stateLabel(row.node)}] ${row.node.title}`;
  const cells = Array.from({ length: layout.plotWidth }, () => " ");
  if (!row.attempt) {
    if (!row.node.timeline_attempts?.length) {
      const status = row.node.state === "dependency_waiting" ? "waiting for dependencies"
        : row.node.state === "ready" ? "ready; no Attempt" : "no Attempt timing";
      for (const [index, char] of [...status].entries()) {
        if (index >= cells.length) break;
        cells[index] = char;
      }
    }
  } else if (row.attempt.timing !== "recorded" || !row.attempt.segments.length || layout.origin === undefined) {
    for (const [index, char] of [..."timing unavailable"].entries()) {
      if (index >= cells.length) break;
      cells[index] = char;
    }
  } else {
    const clockAhead = row.attempt.segments.some((segment) => segment.ended_at === undefined
      && row.attempt!.current && validTime(segment.started_at)! > now);
    if (clockAhead) {
      for (const [index, char] of [..."timing unavailable (clock ahead)"].entries()) {
        if (index >= cells.length) break;
        cells[index] = char;
      }
      return fit(label, layout.labelWidth) + " " + cells.join("");
    }
    for (const segment of row.attempt.segments) {
      const start = validTime(segment.started_at);
      const open: boolean = row.attempt.current && (row.attempt.state === "in_progress" || row.attempt.state === "blocked")
        && segment.ended_at === undefined;
      const end: number | undefined = validTime(segment.ended_at) ?? (open ? now : undefined);
      if (start === undefined || end === undefined || end < start) continue;
      const first = Math.floor((start - layout.origin) / layout.scaleMs) - x;
      const last = Math.max(first, Math.ceil((end - layout.origin) / layout.scaleMs) - x - 1);
      for (let column = Math.max(0, first); column <= Math.min(layout.plotWidth - 1, last); column++) {
        cells[column] = segment.state === "blocked" ? "▒" : "━";
      }
      if (open) {
        const tip = Math.floor((end - layout.origin) / layout.scaleMs) - x;
        if (tip >= 0 && tip < cells.length) cells[tip] = "▶";
      }
    }
  }
  return fit(label, layout.labelWidth) + " " + cells.join("");
}

export function renderTaskTimelineViewport(input: {
  layout: TaskTimelineLayout;
  x: number;
  y: number;
  height: number;
  now: number;
  color?: boolean;
  selectedTaskId?: string;
}): string[] {
  const { layout } = input;
  const x = Math.max(0, Math.min(Math.floor(input.x), layout.maxX));
  const y = Math.max(0, Math.min(Math.floor(input.y), Math.max(0, layout.rows.length - Math.max(0, input.height - 1))));
  return Array.from({ length: Math.max(0, input.height) }, (_, line) => {
    if (line === 0) return fit(axis(layout, x), layout.width);
    const index = y + line - 1;
    const text = fit(lane(layout, index, x, input.now), layout.width);
    if (input.color === false) return text;
    const row = layout.rows[index];
    if (row && row.taskId === input.selectedTaskId) return `\u001b[7m${text}\u001b[0m`;
    const state = row?.attempt?.state;
    const tone = state === "blocked" ? "33" : state === "in_progress" ? "36"
      : row?.attempt?.outcome === "goal_failed" ? "31"
        : row?.attempt?.outcome === "goal_achieved" ? "32" : "90";
    return row?.attempt ? `\u001b[${tone}m${text}\u001b[0m` : text;
  });
}

export function formatTaskTimelineScale(scaleMs: number): string {
  if (scaleMs < 60_000) return `${Math.ceil(scaleMs / 1_000)}s/col`;
  if (scaleMs < 3_600_000) return `${Math.ceil(scaleMs / 60_000)}m/col`;
  return `${(scaleMs / 3_600_000).toFixed(1)}h/col`;
}
