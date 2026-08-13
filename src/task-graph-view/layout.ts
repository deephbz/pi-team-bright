import dagre from "@dagrejs/dagre";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  selectVisibleTaskGraph,
  type TaskGraphEdgeKind,
  type TaskGraphNodeState,
  type TaskGraphRecentLimit,
  type TaskGraphStateFilter,
  type TaskGraphViewEdge,
  type TaskGraphViewNode,
  type TaskGraphViewSource,
  type VisibleTaskGraph,
} from "./source";

export type TaskGraphDirection = "TB" | "LR";
export type TaskGraphCellTone =
  | TaskGraphNodeState
  | "success_edge"
  | "failure_edge"
  | "legacy_edge"
  | "intersection"
  | "muted";

export interface TaskGraphCell {
  char: string;
  tone: TaskGraphCellTone;
}

export interface TaskGraphIsland {
  id: string;
  nodeIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TaskGraphCanvas {
  width: number;
  height: number;
  rows: TaskGraphCell[][];
  visible: VisibleTaskGraph;
  islands: TaskGraphIsland[];
}

export interface TaskGraphLayoutOptions {
  direction?: TaskGraphDirection;
  nodeWidth?: number;
  /** Desired shelf width for deterministic disconnected-island packing. */
  packWidth?: number;
  stateFilter?: TaskGraphStateFilter;
}

interface Point {
  x: number;
  y: number;
}

interface IslandEdgeLayout {
  edge: TaskGraphViewEdge;
  points: Point[];
}

interface IslandLayout {
  id: string;
  nodeIds: string[];
  nodes: Array<{ node: TaskGraphViewNode; x: number; y: number }>;
  edges: IslandEdgeLayout[];
  width: number;
  height: number;
}

interface PackedIsland extends IslandLayout {
  x: number;
  y: number;
}

const EMPTY_CELL: TaskGraphCell = { char: " ", tone: "muted" };
const MIN_NODE_WIDTH = 20;
const DEFAULT_NODE_WIDTH = 30;
const NODE_HEIGHT = 5;
const CONTENT_MARGIN = 2;
const ISLAND_HEADER_HEIGHT = 2;
const ISLAND_GAP_X = 4;
const ISLAND_GAP_Y = 2;
const FAILURE_LANE_STEP = 2;
const EDGE_TONES = new Set<TaskGraphCellTone>([
  "success_edge",
  "failure_edge",
  "legacy_edge",
  "intersection",
]);

function blankRows(width: number, height: number): TaskGraphCell[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ...EMPTY_CELL })));
}

function setCell(rows: TaskGraphCell[][], x: number, y: number, char: string, tone: TaskGraphCellTone): void {
  if (y < 0 || y >= rows.length || x < 0 || x >= (rows[0]?.length ?? 0)) return;
  rows[y][x] = { char, tone };
}

function setPathCell(rows: TaskGraphCell[][], x: number, y: number, char: string, tone: TaskGraphCellTone): void {
  if (y < 0 || y >= rows.length || x < 0 || x >= (rows[0]?.length ?? 0)) return;
  const current = rows[y][x];
  if (current.char === " " || !EDGE_TONES.has(current.tone)) {
    rows[y][x] = { char, tone };
    return;
  }
  if (current.tone !== tone) {
    rows[y][x] = { char: "╳", tone: "intersection" };
    return;
  }
  if (current.char !== char && !["▶", "◀", "▲", "▼"].includes(current.char)) {
    rows[y][x] = { char: "┼", tone };
  }
}

function edgeTone(kind: TaskGraphEdgeKind): TaskGraphCellTone {
  return kind === "goal_achieved" ? "success_edge" : kind === "goal_failed" ? "failure_edge" : "legacy_edge";
}

function edgeLabel(edge: TaskGraphViewEdge): string {
  if (edge.kind === "goal_achieved") return "✓";
  if (edge.kind === "goal_failed") return `×${edge.traversals}/${edge.max_traversals}`;
  return "·";
}

function arrow(from: Point, to: Point): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "▶" : "◀";
  return dy >= 0 ? "▼" : "▲";
}

function drawPath(
  rows: TaskGraphCell[][],
  points: Point[],
  edge: TaskGraphViewEdge,
  offsetX: number,
  offsetY: number,
): void {
  const tone = edgeTone(edge.kind);
  const horizontal = edge.kind === "goal_failed" ? "╌" : edge.kind === "legacy_dependency" ? "─" : "━";
  const vertical = edge.kind === "goal_failed" ? "╎" : edge.kind === "legacy_dependency" ? "│" : "┃";
  for (let index = 1; index < points.length; index++) {
    let x = Math.round(points[index - 1].x) + offsetX;
    let y = Math.round(points[index - 1].y) + offsetY;
    const targetX = Math.round(points[index].x) + offsetX;
    const targetY = Math.round(points[index].y) + offsetY;
    while (x !== targetX) {
      setPathCell(rows, x, y, horizontal, tone);
      x += Math.sign(targetX - x);
    }
    while (y !== targetY) {
      setPathCell(rows, x, y, vertical, tone);
      y += Math.sign(targetY - y);
    }
    if (index < points.length - 1) setPathCell(rows, x, y, "┼", tone);
  }
  if (points.length > 1) {
    const before = points[points.length - 2];
    const end = points[points.length - 1];
    setPathCell(rows, Math.round(end.x) + offsetX, Math.round(end.y) + offsetY, arrow(before, end), tone);
  }
}

function drawEdgeLabel(
  rows: TaskGraphCell[][],
  layout: IslandEdgeLayout,
  offsetX: number,
  offsetY: number,
): void {
  const label = [...edgeLabel(layout.edge)];
  const point = layout.points[Math.floor(layout.points.length / 2)];
  if (!point) return;
  const centerX = Math.round(point.x) + offsetX;
  const centerY = Math.round(point.y) + offsetY;
  const candidates = [
    ...[-1, 0, 1].flatMap((dy) => [centerX + 1, centerX - label.length - 1].map((x) => ({ x, y: centerY + dy }))),
    ...[-2, 2].flatMap((dy) => [centerX, centerX - label.length].map((x) => ({ x, y: centerY + dy }))),
  ];
  const location = candidates.find(({ x, y }) => label.every((_char, index) => {
    const cell = rows[y]?.[x + index];
    return cell && (cell.char === " " || EDGE_TONES.has(cell.tone));
  }));
  if (!location) return;
  const tone = edgeTone(layout.edge.kind);
  for (const [index, char] of label.entries()) setCell(rows, location.x + index, location.y, char, tone);
}

function plainTruncate(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width), "…").replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function padded(text: string, width: number): string {
  const clipped = plainTruncate(text, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function failureLabel(node: TaskGraphViewNode): string {
  switch (node.failure_reason) {
    case "criterion_failed": return "criterion";
    case "failure_edge_exhausted": return "edge exhausted";
    case "dependency_failed": return "dependency";
    case "dependency_cancelled": return "dependency cancelled";
    default: return "";
  }
}

function stateIcon(state: TaskGraphNodeState): string {
  switch (state) {
    case "dependency_waiting": return "◷";
    case "ready": return "●";
    case "in_progress": return "▶";
    case "blocked": return "■";
    case "goal_failed": return "✕";
    case "goal_achieved": return "✓";
    case "cancelled": return "⊘";
    case "legacy_completed": return "?";
  }
}

function attemptLabel(node: TaskGraphViewNode): string {
  if (node.attempts_started === undefined || node.model_alias === undefined) return "legacy Task card";
  const attempt = node.display_attempt;
  if (!attempt) return `tries ${node.attempts_started} · ${node.model_alias}`;
  const current = attempt.current ? " current" : "";
  return `try ${attempt.ordinal}/${node.attempts_started} · ${attempt.model_alias}${current} · ${attempt.resolved_model}`;
}

function nodeLabel(
  node: TaskGraphViewNode,
  isJoin: boolean,
  failureEdge: TaskGraphViewEdge | undefined,
  innerWidth: number,
): [string, string, string] {
  const stateDetail = node.state === "goal_failed" ? ` · ${failureLabel(node)}` : "";
  const badges = `${isJoin ? " ⋈" : ""}${failureEdge ? ` ↺${failureEdge.traversals}/${failureEdge.max_traversals}` : ""}`;
  const first = padded(`${stateIcon(node.state)} ${node.state}${stateDetail}${badges}`, innerWidth);
  const owner = node.assignee ? ` · ${node.assignee}` : "";
  return [first, padded(`${node.title}${owner}`, innerWidth), padded(attemptLabel(node), innerWidth)];
}

function drawNode(
  rows: TaskGraphCell[][],
  node: TaskGraphViewNode,
  x: number,
  y: number,
  width: number,
  isJoin: boolean,
  failureEdge?: TaskGraphViewEdge,
): void {
  const left = Math.round(x - width / 2);
  const top = Math.round(y - NODE_HEIGHT / 2);
  const innerWidth = width - 2;
  const [status, title, attempt] = nodeLabel(node, isJoin, failureEdge, innerWidth);
  const lines = [
    `┌${"─".repeat(innerWidth)}┐`,
    `│${status}│`,
    `│${title}│`,
    `│${attempt}│`,
    `└${"─".repeat(innerWidth)}┘`,
  ];
  for (const [dy, line] of lines.entries()) {
    for (const [dx, char] of [...line].entries()) setCell(rows, left + dx, top + dy, char, node.state);
  }
}

function weakComponents(visible: VisibleTaskGraph): Array<{ nodes: TaskGraphViewNode[]; edges: TaskGraphViewEdge[] }> {
  const order = new Map(visible.nodes.map((node, index) => [node.id, index]));
  const nodeById = new Map(visible.nodes.map((node) => [node.id, node]));
  const adjacent = new Map(visible.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of visible.edges) {
    if (edge.from_task_id === edge.to_task_id) continue;
    adjacent.get(edge.from_task_id)?.add(edge.to_task_id);
    adjacent.get(edge.to_task_id)?.add(edge.from_task_id);
  }
  const remaining = new Set(visible.nodes.map((node) => node.id));
  const result: Array<{ nodes: TaskGraphViewNode[]; edges: TaskGraphViewEdge[] }> = [];
  for (const seed of visible.nodes.map((node) => node.id)) {
    if (!remaining.delete(seed)) continue;
    const ids = [seed];
    for (let index = 0; index < ids.length; index++) {
      const neighbors = [...(adjacent.get(ids[index]) ?? [])]
        .sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0) || left.localeCompare(right));
      for (const neighbor of neighbors) {
        if (!remaining.delete(neighbor)) continue;
        ids.push(neighbor);
      }
    }
    const idSet = new Set(ids);
    result.push({
      nodes: ids.map((id) => nodeById.get(id)!),
      edges: visible.edges.filter((edge) => idSet.has(edge.from_task_id) && idSet.has(edge.to_task_id)),
    });
  }
  return result;
}

function layoutIsland(
  component: { nodes: TaskGraphViewNode[]; edges: TaskGraphViewEdge[] },
  direction: TaskGraphDirection,
  nodeWidth: number,
): IslandLayout {
  const graph = new dagre.graphlib.Graph({ directed: true, multigraph: true });
  graph.setGraph({
    rankdir: direction,
    nodesep: direction === "TB" ? 4 : 3,
    edgesep: 2,
    ranksep: direction === "TB" ? 6 : 9,
    marginx: 0,
    marginy: 0,
    ranker: "network-simplex",
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of component.nodes) graph.setNode(node.id, { width: nodeWidth, height: NODE_HEIGHT });
  const forwardEdges = component.edges.filter((edge) => edge.kind !== "goal_failed");
  for (const [index, edge] of forwardEdges.entries()) {
    graph.setEdge(edge.from_task_id, edge.to_task_id, { minlen: 1, weight: 1 }, `${edge.kind}-${index}`);
  }
  if (component.nodes.length === 1 && forwardEdges.length === 0) {
    graph.setNode(component.nodes[0].id, { width: nodeWidth, height: NODE_HEIGHT, x: nodeWidth / 2, y: NODE_HEIGHT / 2 });
    graph.setGraph({ ...graph.graph(), width: nodeWidth, height: NODE_HEIGHT });
  } else {
    dagre.layout(graph);
  }

  const label = graph.graph() as { width?: number; height?: number };
  const graphWidth = Math.max(nodeWidth, Math.ceil(label.width ?? nodeWidth));
  const graphHeight = Math.max(NODE_HEIGHT, Math.ceil(label.height ?? NODE_HEIGHT));
  const contentOffsetX = CONTENT_MARGIN;
  const contentOffsetY = CONTENT_MARGIN + ISLAND_HEADER_HEIGHT;
  const positions = new Map<string, Point>();
  const nodes = component.nodes.map((node) => {
    const position = graph.node(node.id) as { x?: number; y?: number };
    const point = {
      x: Math.round(position.x ?? nodeWidth / 2) + contentOffsetX,
      y: Math.round(position.y ?? NODE_HEIGHT / 2) + contentOffsetY,
    };
    positions.set(node.id, point);
    return { node, ...point };
  });

  const edges: IslandEdgeLayout[] = forwardEdges.map((edge, index) => {
    const graphEdge = graph.edge({ v: edge.from_task_id, w: edge.to_task_id, name: `${edge.kind}-${index}` }) as { points?: Point[] } | undefined;
    return {
      edge,
      points: (graphEdge?.points ?? []).map((point) => ({
        x: point.x + contentOffsetX,
        y: point.y + contentOffsetY,
      })),
    };
  });
  const failureEdges = component.edges.filter((edge) => edge.kind === "goal_failed")
    .sort((left, right) => left.from_task_id.localeCompare(right.from_task_id) || left.to_task_id.localeCompare(right.to_task_id));
  const laneStart = graphWidth + contentOffsetX + CONTENT_MARGIN;
  for (const [index, edge] of failureEdges.entries()) {
    const source = positions.get(edge.from_task_id)!;
    const target = positions.get(edge.to_task_id)!;
    const laneX = laneStart + index * FAILURE_LANE_STEP;
    const sourceX = source.x + nodeWidth / 2;
    const targetX = target.x + nodeWidth / 2;
    const verticalOffset = edge.from_task_id === edge.to_task_id ? Math.max(2, Math.floor(NODE_HEIGHT / 2)) : 0;
    edges.push({
      edge,
      points: edge.from_task_id === edge.to_task_id
        ? [
          { x: sourceX, y: source.y - verticalOffset },
          { x: laneX, y: source.y - verticalOffset },
          { x: laneX, y: source.y + verticalOffset },
          { x: targetX, y: target.y + verticalOffset },
        ]
        : [
          { x: sourceX, y: source.y },
          { x: laneX, y: source.y },
          { x: laneX, y: target.y },
          { x: targetX, y: target.y },
        ],
    });
  }
  const failureLaneWidth = failureEdges.length ? CONTENT_MARGIN + failureEdges.length * FAILURE_LANE_STEP : 0;
  return {
    id: component.nodes[0].id,
    nodeIds: component.nodes.map((node) => node.id),
    nodes,
    edges,
    width: graphWidth + CONTENT_MARGIN * 2 + failureLaneWidth + 1,
    height: graphHeight + CONTENT_MARGIN * 2 + ISLAND_HEADER_HEIGHT + 1,
  };
}

function packIslands(layouts: IslandLayout[], requestedWidth: number): PackedIsland[] {
  if (!layouts.length) return [];
  const targetWidth = Math.max(Math.max(...layouts.map((layout) => layout.width)), Math.round(requestedWidth));
  const packed: PackedIsland[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const layout of layouts) {
    if (x > 0 && x + layout.width > targetWidth) {
      x = 0;
      y += rowHeight + ISLAND_GAP_Y;
      rowHeight = 0;
    }
    packed.push({ ...layout, x, y });
    x += layout.width + ISLAND_GAP_X;
    rowHeight = Math.max(rowHeight, layout.height);
  }
  return packed;
}

/** Lay out success DAGs independently, then pack disconnected islands. */
export function layoutTaskGraph(
  source: TaskGraphViewSource,
  limit: TaskGraphRecentLimit,
  options: TaskGraphLayoutOptions = {},
): TaskGraphCanvas {
  const visible = selectVisibleTaskGraph(source, limit, options.stateFilter ?? "all");
  const direction = options.direction ?? "TB";
  const nodeWidth = Math.max(MIN_NODE_WIDTH, Math.min(60, Math.round(options.nodeWidth ?? DEFAULT_NODE_WIDTH)));
  if (visible.nodes.length === 0) {
    return { width: 1, height: 1, rows: [[{ ...EMPTY_CELL }]], visible, islands: [] };
  }

  const layouts = weakComponents(visible).map((component) => layoutIsland(component, direction, nodeWidth));
  const packed = packIslands(layouts, options.packWidth ?? 240);
  const width = Math.max(1, ...packed.map((island) => island.x + island.width));
  const height = Math.max(1, ...packed.map((island) => island.y + island.height));
  const rows = blankRows(width, height);
  for (const [index, island] of packed.entries()) {
    const label = plainTruncate(`island ${index + 1}/${packed.length} · ${island.nodeIds.length} task${island.nodeIds.length === 1 ? "" : "s"}`, island.width - 1);
    for (const [dx, char] of [...label].entries()) setCell(rows, island.x + dx + 1, island.y, char, "muted");
    for (const edge of island.edges) drawPath(rows, edge.points, edge.edge, island.x, island.y);
  }
  for (const island of packed) {
    const failureBySource = new Map(island.edges
      .filter(({ edge }) => edge.kind === "goal_failed")
      .map(({ edge }) => [edge.from_task_id, edge]));
    for (const position of island.nodes) {
      drawNode(
        rows,
        position.node,
        position.x + island.x,
        position.y + island.y,
        nodeWidth,
        visible.joinTaskIds.has(position.node.id),
        failureBySource.get(position.node.id),
      );
    }
  }
  for (const island of packed) {
    for (const edge of island.edges) drawEdgeLabel(rows, edge, island.x, island.y);
  }
  return {
    width,
    height,
    rows,
    visible,
    islands: packed.map((island) => ({
      id: island.id,
      nodeIds: island.nodeIds,
      x: island.x,
      y: island.y,
      width: island.width,
      height: island.height,
    })),
  };
}

// Use semantic terminal slots, not fixed xterm-256 colors. The terminal theme
// owns each slot's concrete color and polarity, so one running pane follows a
// light or dark Colorstack/Ghostty theme without reading configuration files.
// ANSI 8 (bright black) is the theme-owned legible secondary-text role.
const ANSI: Record<TaskGraphCellTone, string> = {
  dependency_waiting: "\u001b[33m",
  ready: "\u001b[1;32m",
  in_progress: "\u001b[1;36m",
  blocked: "\u001b[1;35m",
  goal_failed: "\u001b[1;31m",
  goal_achieved: "\u001b[32m",
  cancelled: "\u001b[90m",
  legacy_completed: "\u001b[90m",
  success_edge: "\u001b[32m",
  failure_edge: "\u001b[33m",
  legacy_edge: "\u001b[36m",
  intersection: "\u001b[1;39m",
  muted: "\u001b[90m",
};
const RESET = "\u001b[0m";

export function renderTaskGraphViewport(input: {
  canvas: TaskGraphCanvas;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: boolean;
}): string[] {
  const width = Math.max(1, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const x = Math.max(0, Math.min(Math.floor(input.x), Math.max(0, input.canvas.width - width)));
  const y = Math.max(0, Math.min(Math.floor(input.y), Math.max(0, input.canvas.height - height)));
  return Array.from({ length: height }, (_, rowOffset) => {
    const row = input.canvas.rows[y + rowOffset] ?? [];
    let tone: TaskGraphCellTone | undefined;
    let output = "";
    for (let columnOffset = 0; columnOffset < width; columnOffset++) {
      const cell = row[x + columnOffset] ?? EMPTY_CELL;
      if (input.color !== false && cell.tone !== tone) {
        output += `${RESET}${ANSI[cell.tone]}`;
        tone = cell.tone;
      }
      output += cell.char;
    }
    return input.color === false ? output : `${output}${RESET}`;
  });
}
