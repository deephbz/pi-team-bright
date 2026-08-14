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
export type TaskGraphNavigationDirection = "left" | "right" | "up" | "down";
export type TaskGraphCellTone =
  | TaskGraphNodeState
  | "selected"
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

export interface TaskGraphNodeBox {
  node: TaskGraphViewNode;
  islandIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface TaskGraphCanvas {
  width: number;
  height: number;
  rows: TaskGraphCell[][];
  visible: VisibleTaskGraph;
  islands: TaskGraphIsland[];
  nodes: TaskGraphNodeBox[];
}

export interface TaskGraphLayoutOptions {
  direction?: TaskGraphDirection;
  nodeWidth?: number;
  /** Desired shelf width for deterministic disconnected-island packing. */
  packWidth?: number;
  stateFilter?: TaskGraphStateFilter;
  /** Stable render instant. It affects time labels, never graph placement. */
  now?: number;
}

interface Point {
  x: number;
  y: number;
}

interface IslandEdgeLayout {
  edge: TaskGraphViewEdge;
  points: Point[];
  rasterPoints?: Point[];
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
const MIN_NODE_WIDTH = 28;
const DEFAULT_NODE_WIDTH = 38;
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
const NORTH = 1;
const EAST = 2;
const SOUTH = 4;
const WEST = 8;

interface RouteCell {
  mask: number;
  tones: Set<TaskGraphCellTone>;
}

type RoutePlane = Map<string, RouteCell>;

function blankRows(width: number, height: number): TaskGraphCell[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ...EMPTY_CELL })));
}

function setCell(rows: TaskGraphCell[][], x: number, y: number, char: string, tone: TaskGraphCellTone): void {
  if (y < 0 || y >= rows.length || x < 0 || x >= (rows[0]?.length ?? 0)) return;
  rows[y][x] = { char, tone };
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

function routeKey(point: Point): string {
  return `${point.x},${point.y}`;
}

function directionBit(from: Point, to: Point): number {
  if (to.x > from.x) return EAST;
  if (to.x < from.x) return WEST;
  if (to.y > from.y) return SOUTH;
  return NORTH;
}

function opposite(bit: number): number {
  return bit === NORTH ? SOUTH : bit === SOUTH ? NORTH : bit === EAST ? WEST : EAST;
}

function addConnection(routes: RoutePlane, from: Point, to: Point, tone: TaskGraphCellTone): void {
  const bit = directionBit(from, to);
  const left = routes.get(routeKey(from)) ?? { mask: 0, tones: new Set<TaskGraphCellTone>() };
  const right = routes.get(routeKey(to)) ?? { mask: 0, tones: new Set<TaskGraphCellTone>() };
  left.mask |= bit;
  right.mask |= opposite(bit);
  left.tones.add(tone);
  right.tones.add(tone);
  routes.set(routeKey(from), left);
  routes.set(routeKey(to), right);
}

function appendStraight(result: Point[], target: Point): void {
  let current = result.at(-1)!;
  while (current.x !== target.x || current.y !== target.y) {
    current = {
      x: current.x + Math.sign(target.x - current.x),
      y: current.y + Math.sign(target.y - current.y),
    };
    result.push(current);
  }
}

/** Convert Dagre splines into stable orthogonal terminal cells. */
function rasterizePath(points: readonly Point[], direction: TaskGraphDirection, offsetX: number, offsetY: number): Point[] {
  if (!points.length) return [];
  const translated = points.map((point) => ({ x: Math.round(point.x) + offsetX, y: Math.round(point.y) + offsetY }));
  const result = [translated[0]];
  for (const target of translated.slice(1)) {
    const start = result.at(-1)!;
    if (start.x === target.x || start.y === target.y) {
      appendStraight(result, target);
      continue;
    }
    if (direction === "TB") {
      const middleY = Math.round((start.y + target.y) / 2);
      appendStraight(result, { x: start.x, y: middleY });
      appendStraight(result, { x: target.x, y: middleY });
    } else {
      const middleX = Math.round((start.x + target.x) / 2);
      appendStraight(result, { x: middleX, y: start.y });
      appendStraight(result, { x: middleX, y: target.y });
    }
    appendStraight(result, target);
  }
  return result.filter((point, index) => index === 0 || point.x !== result[index - 1].x || point.y !== result[index - 1].y);
}

function addPath(routes: RoutePlane, points: readonly Point[], tone: TaskGraphCellTone): void {
  for (let index = 1; index < points.length; index++) addConnection(routes, points[index - 1], points[index], tone);
}

function routeCharacter(mask: number, tone: TaskGraphCellTone): string {
  const heavy = tone === "success_edge";
  const horizontal = tone === "failure_edge" ? "╌" : heavy ? "━" : "─";
  const vertical = tone === "failure_edge" ? "╎" : heavy ? "┃" : "│";
  if (mask === (EAST | WEST)) return horizontal;
  if (mask === (NORTH | SOUTH)) return vertical;
  const glyphs = heavy
    ? new Map([[EAST | SOUTH, "┏"], [WEST | SOUTH, "┓"], [EAST | NORTH, "┗"], [WEST | NORTH, "┛"], [NORTH | EAST | SOUTH, "┣"], [NORTH | WEST | SOUTH, "┫"], [EAST | SOUTH | WEST, "┳"], [EAST | NORTH | WEST, "┻"], [NORTH | EAST | SOUTH | WEST, "╋"]])
    : new Map([[EAST | SOUTH, "┌"], [WEST | SOUTH, "┐"], [EAST | NORTH, "└"], [WEST | NORTH, "┘"], [NORTH | EAST | SOUTH, "├"], [NORTH | WEST | SOUTH, "┤"], [EAST | SOUTH | WEST, "┬"], [EAST | NORTH | WEST, "┴"], [NORTH | EAST | SOUTH | WEST, "┼"]]);
  return glyphs.get(mask) ?? (mask & (EAST | WEST) ? horizontal : vertical);
}

function paintRoutes(rows: TaskGraphCell[][], routes: RoutePlane): void {
  for (const [key, route] of routes) {
    const [x, y] = key.split(",").map(Number);
    const tones = [...route.tones];
    const tone = tones.length === 1 ? tones[0] : "intersection";
    setCell(rows, x, y, routeCharacter(route.mask, tone), tone);
  }
}

function drawArrow(rows: TaskGraphCell[][], points: readonly Point[], edge: TaskGraphViewEdge): void {
  if (points.length < 2) return;
  const end = points.at(-1)!;
  setCell(rows, end.x, end.y, arrow(points.at(-2)!, end), edgeTone(edge.kind));
}

function drawEdgeLabel(
  rows: TaskGraphCell[][],
  layout: IslandEdgeLayout,
  offsetX: number,
  offsetY: number,
): void {
  const label = [...edgeLabel(layout.edge)];
  const points = layout.rasterPoints ?? layout.points;
  if (!points.length) return;
  const anchorIndexes = [
    Math.floor(points.length / 2),
    Math.floor(points.length / 3),
    Math.floor(points.length * 2 / 3),
    ...points.map((_point, index) => index),
  ];
  const candidates = [...new Set(anchorIndexes)].flatMap((index) => {
    const anchor = points[index];
    if (!anchor) return [];
    const centerX = Math.round(anchor.x) + (layout.rasterPoints ? 0 : offsetX);
    const centerY = Math.round(anchor.y) + (layout.rasterPoints ? 0 : offsetY);
    return [-1, 0, 1, -2, 2].flatMap((dy) => [
      { x: centerX + 1, y: centerY + dy },
      { x: centerX - label.length - 1, y: centerY + dy },
    ]);
  });
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

export function taskGraphAttemptLabel(node: TaskGraphViewNode): string {
  if (node.attempts_started === undefined || node.model_alias === undefined) return "legacy Task card";
  const attempt = node.display_attempt;
  if (!attempt) return `tries ${node.attempts_started} · ${node.model_alias}`;
  const current = attempt.current ? " current" : "";
  return `try ${attempt.ordinal}/${node.attempts_started} · ${attempt.model_alias}${current} · ${attempt.resolved_model}`;
}

export function formatTaskGraphDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function terminalState(state: TaskGraphNodeState): boolean {
  return ["goal_achieved", "goal_failed", "cancelled", "legacy_completed"].includes(state);
}

function timingLabel(node: TaskGraphViewNode, now: number): string {
  if (!node.first_activity_at || !node.last_activity_at) return "updated unknown · elapsed unknown";
  const updated = Date.parse(node.last_activity_at);
  const end = terminalState(node.state) ? updated : now;
  return `updated ${formatTaskGraphDuration(Math.max(0, now - updated))} ago · elapsed ${formatTaskGraphDuration(Math.max(0, end - Date.parse(node.first_activity_at)))}`;
}

function priorityLine(prefix: string, value: string, width: number): string {
  if (visibleWidth(prefix) >= width) return padded(prefix, width);
  return padded(prefix + plainTruncate(value, width - visibleWidth(prefix)), width);
}

function nodeLabel(
  node: TaskGraphViewNode,
  isJoin: boolean,
  failureEdge: TaskGraphViewEdge | undefined,
  innerWidth: number,
  now: number,
): [string, string, string] {
  const identity = `${node.id}@${node.assignee ?? "unassigned"}`;
  const first = priorityLine(`[${node.state}] `, identity, innerWidth);
  const stateDetail = node.state === "goal_failed" ? `${failureLabel(node)} ` : "";
  const badges = `${isJoin ? "⋈ " : ""}${failureEdge ? `↺${failureEdge.traversals}/${failureEdge.max_traversals} ` : ""}${stateDetail}`;
  return [first, priorityLine(badges, node.title, innerWidth), padded(timingLabel(node, now), innerWidth)];
}

function drawNode(
  rows: TaskGraphCell[][],
  node: TaskGraphViewNode,
  x: number,
  y: number,
  width: number,
  isJoin: boolean,
  now: number,
  failureEdge?: TaskGraphViewEdge,
): void {
  const left = Math.round(x - width / 2);
  const top = Math.round(y - NODE_HEIGHT / 2);
  const innerWidth = width - 2;
  const [status, title, timing] = nodeLabel(node, isJoin, failureEdge, innerWidth, now);
  const lines = [
    `┌${"─".repeat(innerWidth)}┐`,
    `│${status}│`,
    `│${title}│`,
    `│${timing}│`,
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
    return { width: 1, height: 1, rows: [[{ ...EMPTY_CELL }]], visible, islands: [], nodes: [] };
  }

  const layouts = weakComponents(visible).map((component) => layoutIsland(component, direction, nodeWidth));
  const packed = packIslands(layouts, options.packWidth ?? 240);
  const width = Math.max(1, ...packed.map((island) => island.x + island.width));
  const height = Math.max(1, ...packed.map((island) => island.y + island.height));
  const rows = blankRows(width, height);
  const routes: RoutePlane = new Map();
  for (const [index, island] of packed.entries()) {
    const label = plainTruncate(`island ${index + 1}/${packed.length} · ${island.nodeIds.length} task${island.nodeIds.length === 1 ? "" : "s"}`, island.width - 1);
    for (const [dx, char] of [...label].entries()) setCell(rows, island.x + dx + 1, island.y, char, "muted");
    for (const edge of island.edges) {
      edge.rasterPoints = rasterizePath(edge.points, direction, island.x, island.y);
      addPath(routes, edge.rasterPoints, edgeTone(edge.edge.kind));
    }
  }
  paintRoutes(rows, routes);
  const nodeBoxes: TaskGraphNodeBox[] = [];
  for (const [islandIndex, island] of packed.entries()) {
    const failureBySource = new Map(island.edges
      .filter(({ edge }) => edge.kind === "goal_failed")
      .map(({ edge }) => [edge.from_task_id, edge]));
    for (const position of island.nodes) {
      const centerX = position.x + island.x;
      const centerY = position.y + island.y;
      drawNode(
        rows,
        position.node,
        centerX,
        centerY,
        nodeWidth,
        visible.joinTaskIds.has(position.node.id),
        options.now ?? Date.now(),
        failureBySource.get(position.node.id),
      );
      nodeBoxes.push({
        node: position.node,
        islandIndex,
        x: Math.round(centerX - nodeWidth / 2),
        y: Math.round(centerY - NODE_HEIGHT / 2),
        width: nodeWidth,
        height: NODE_HEIGHT,
        centerX,
        centerY,
      });
    }
  }
  for (const island of packed) {
    for (const edge of island.edges) drawArrow(rows, edge.rasterPoints ?? [], edge.edge);
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
    nodes: nodeBoxes,
  };
}

/** Select the nearest node in one visual direction with stable tie-breaking. */
export function findDirectionalTaskGraphNode(
  canvas: TaskGraphCanvas,
  taskId: string,
  direction: TaskGraphNavigationDirection,
): TaskGraphNodeBox | undefined {
  const current = canvas.nodes.find((box) => box.node.id === taskId);
  if (!current) return undefined;
  const candidates = canvas.nodes.flatMap((candidate) => {
    if (candidate.node.id === taskId) return [];
    const dx = candidate.centerX - current.centerX;
    const dy = candidate.centerY - current.centerY;
    const primary = direction === "left" ? -dx
      : direction === "right" ? dx
        : direction === "up" ? -dy
          : dy;
    if (primary <= 0) return [];
    const perpendicular = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    return [{ candidate, primary, perpendicular, score: primary * 2 + perpendicular }];
  });
  candidates.sort((left, right) => left.score - right.score
    || left.perpendicular - right.perpendicular
    || left.primary - right.primary
    || left.candidate.node.id.localeCompare(right.candidate.node.id));
  return candidates[0]?.candidate;
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
  selected: "\u001b[1;97;44m",
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
  selectedTaskId?: string;
}): string[] {
  const width = Math.max(1, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const x = Math.max(0, Math.min(Math.floor(input.x), Math.max(0, input.canvas.width - width)));
  const y = Math.max(0, Math.min(Math.floor(input.y), Math.max(0, input.canvas.height - height)));
  const selected = input.selectedTaskId
    ? input.canvas.nodes.find((node) => node.node.id === input.selectedTaskId)
    : undefined;
  return Array.from({ length: height }, (_, rowOffset) => {
    const row = input.canvas.rows[y + rowOffset] ?? [];
    let tone: TaskGraphCellTone | undefined;
    let output = "";
    for (let columnOffset = 0; columnOffset < width; columnOffset++) {
      const canvasX = x + columnOffset;
      const canvasY = y + rowOffset;
      const cell = row[canvasX] ?? EMPTY_CELL;
      const cellTone = selected
        && canvasX >= selected.x && canvasX < selected.x + selected.width
        && canvasY >= selected.y && canvasY < selected.y + selected.height
        ? "selected"
        : cell.tone;
      if (input.color !== false && cellTone !== tone) {
        output += `${RESET}${ANSI[cellTone]}`;
        tone = cellTone;
      }
      output += cell.char;
    }
    return input.color === false ? output : `${output}${RESET}`;
  });
}
