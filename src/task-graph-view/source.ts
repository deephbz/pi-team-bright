import { createHash } from "node:crypto";
import type {
  GraphAttemptView,
  GraphControlModelAlias,
  GraphTaskController,
  GraphTaskView,
} from "../task-authority/graph-control";
import type { TaskCard } from "../task-authority/task-domain";

export const TASK_GRAPH_VIEW_SCHEMA = "pi-team-bright-task-graph-view/3" as const;
export const TASK_GRAPH_DEFAULT_LIMIT = 50;
export const TASK_GRAPH_LIMITS = [25, 50, 100, 200] as const;
export const TASK_GRAPH_MAX_NODES = 5_000;
export const TASK_GRAPH_MAX_EDGES = 20_000;
export const TASK_GRAPH_MAX_ATTEMPTS = 100_000;
export const TASK_GRAPH_MAX_EVENTS = 200_000;
export const TASK_GRAPH_MAX_SOURCE_BYTES = 24_000_000;

export type TaskGraphRecentLimit = (typeof TASK_GRAPH_LIMITS)[number] | "all";
export type TaskGraphStateFilter = "all" | "actionable" | "nonterminal" | "failed";
export type TaskGraphSourceAuthority = "graph_control" | "legacy_task_cards";
export type TaskGraphNodeState =
  | "dependency_waiting"
  | "ready"
  | "in_progress"
  | "blocked"
  | "goal_failed"
  | "goal_achieved"
  | "cancelled"
  | "legacy_completed";
export type TaskGraphFailureReason =
  | "criterion_failed"
  | "failure_edge_exhausted"
  | "dependency_failed"
  | "dependency_cancelled";
export type TaskGraphEdgeKind = "goal_achieved" | "goal_failed" | "legacy_dependency";
export type TaskGraphAttemptState = GraphAttemptView["state"];
export type TaskGraphAttemptOutcome = NonNullable<GraphAttemptView["outcome"]>;

export type TaskGraphControlTrace = ReturnType<GraphTaskController["trace"]>;

export interface TaskGraphActivityCoordinate {
  taskId: string;
  cursor: string;
  firstActivityAt?: string;
  lastActivityAt?: string;
}

export interface TaskGraphActivityProjection {
  headCursor: string;
  tasks: readonly TaskGraphActivityCoordinate[];
}

export interface TaskGraphAttemptDetail {
  id: string;
  ordinal: number;
  state: TaskGraphAttemptState;
  current: boolean;
  model_alias: GraphControlModelAlias;
  resolved_model: string;
  outcome?: TaskGraphAttemptOutcome;
}

export interface TaskGraphViewNode {
  id: string;
  title: string;
  goal?: string;
  current_context?: string;
  assignee?: string;
  state: TaskGraphNodeState;
  waiting_on_task_ids: string[];
  activity_cursor: string;
  first_activity_at?: string;
  last_activity_at?: string;
  model_alias?: GraphControlModelAlias;
  attempts_started?: number;
  display_attempt?: TaskGraphAttemptDetail;
  failure_reason?: TaskGraphFailureReason;
}

export interface TaskGraphViewEdge {
  from_task_id: string;
  to_task_id: string;
  kind: TaskGraphEdgeKind;
  traversals?: number;
  max_traversals?: number;
}

export interface TaskGraphViewSource {
  schema: typeof TASK_GRAPH_VIEW_SCHEMA;
  team_name: string;
  authority: TaskGraphSourceAuthority;
  source_revision: string;
  graph_version?: string;
  authority_sequence?: string;
  nodes: TaskGraphViewNode[];
  edges: TaskGraphViewEdge[];
}

export interface VisibleTaskGraph {
  source: TaskGraphViewSource;
  limit: TaskGraphRecentLimit;
  stateFilter: TaskGraphStateFilter;
  nodes: TaskGraphViewNode[];
  edges: TaskGraphViewEdge[];
  joinTaskIds: ReadonlySet<string>;
  omittedNodeCount: number;
  recencyOmittedNodeCount: number;
  filterOmittedNodeCount: number;
  boundaryEdgeCount: number;
}

const SOURCE_AUTHORITY = new Set<TaskGraphSourceAuthority>(["graph_control", "legacy_task_cards"]);
const NODE_STATE = new Set<TaskGraphNodeState>([
  "dependency_waiting",
  "ready",
  "in_progress",
  "blocked",
  "goal_failed",
  "goal_achieved",
  "cancelled",
  "legacy_completed",
]);
const FAILURE_REASON = new Set<TaskGraphFailureReason>([
  "criterion_failed",
  "failure_edge_exhausted",
  "dependency_failed",
  "dependency_cancelled",
]);
const EDGE_KIND = new Set<TaskGraphEdgeKind>(["goal_achieved", "goal_failed", "legacy_dependency"]);
const ATTEMPT_STATE = new Set<TaskGraphAttemptState>(["in_progress", "blocked", "completed", "superseded", "cancelled"]);
const ATTEMPT_OUTCOME = new Set<TaskGraphAttemptOutcome>(["goal_achieved", "goal_failed"]);
const MODEL_ALIAS = new Set<GraphControlModelAlias>(["default", "capable"]);
const CURSOR = /^(0|[1-9][0-9]*)$/;

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allowedSet.has(key));
  if (extra) throw new Error(`${field} contains unsupported field ${JSON.stringify(extra)}.`);
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new Error(`${field} must be a nonempty string no longer than ${maxLength} characters.`);
  }
  return value;
}

function identityString(value: unknown, field: string, maxLength: number): string {
  const text = boundedString(value, field, maxLength);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
    throw new Error(`${field} contains terminal control characters.`);
  }
  return text;
}

/** Remove terminal controls before any untrusted text enters styled output. */
export function sanitizeTaskGraphDisplayText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)?/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-_]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function displayString(value: unknown, field: string, maxLength: number): string {
  const raw = boundedString(value, field, maxLength);
  const clean = sanitizeTaskGraphDisplayText(raw);
  if (!clean) throw new Error(`${field} contains no displayable text.`);
  return clean;
}

function parseCursor(value: unknown, field: string): string {
  const cursor = identityString(value, field, 64);
  if (!CURSOR.test(cursor)) throw new Error(`${field} must be a nonnegative decimal cursor.`);
  return cursor;
}

function isoInstant(value: unknown, field: string): string {
  const text = identityString(value, field, 64);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    throw new Error(`${field} must be a canonical ISO-8601 instant.`);
  }
  return text;
}

function parseBoundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function compareRecent(a: TaskGraphViewNode, b: TaskGraphViewNode): number {
  const cursorOrder = BigInt(b.activity_cursor) > BigInt(a.activity_cursor)
    ? 1
    : BigInt(b.activity_cursor) < BigInt(a.activity_cursor)
      ? -1
      : 0;
  return cursorOrder || a.id.localeCompare(b.id);
}

function dependencyKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function edgeKey(edge: TaskGraphViewEdge): string {
  return `${edge.kind}\u0000${dependencyKey(edge.from_task_id, edge.to_task_id)}`;
}

function assertSuccessAcyclic(nodes: readonly TaskGraphViewNode[], edges: readonly TaskGraphViewEdge[]): void {
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (edge.kind !== "goal_failed") outgoing.get(edge.from_task_id)!.push(edge.to_task_id);
  }
  const active = new Set<string>();
  const complete = new Set<string>();
  const visit = (taskId: string) => {
    if (complete.has(taskId)) return;
    if (active.has(taskId)) throw new Error("Task graph view contains a success dependency cycle; only explicit goal_failed edges can form loops.");
    active.add(taskId);
    for (const target of outgoing.get(taskId) ?? []) visit(target);
    active.delete(taskId);
    complete.add(taskId);
  };
  for (const node of nodes) visit(node.id);
}

function parseAttempt(value: unknown, field: string): TaskGraphAttemptDetail {
  const attempt = record(value, field);
  exactKeys(attempt, ["id", "ordinal", "state", "current", "model_alias", "resolved_model", "outcome"], field);
  if (!ATTEMPT_STATE.has(attempt.state as TaskGraphAttemptState)) throw new Error(`${field}.state is invalid.`);
  if (typeof attempt.current !== "boolean") throw new Error(`${field}.current must be boolean.`);
  if (!MODEL_ALIAS.has(attempt.model_alias as GraphControlModelAlias)) throw new Error(`${field}.model_alias is invalid.`);
  if (attempt.outcome !== undefined && !ATTEMPT_OUTCOME.has(attempt.outcome as TaskGraphAttemptOutcome)) {
    throw new Error(`${field}.outcome is invalid.`);
  }
  if ((attempt.state === "completed") !== (attempt.outcome !== undefined)) {
    throw new Error(`${field} must include outcome exactly when its state is completed.`);
  }
  return {
    id: identityString(attempt.id, `${field}.id`, 160),
    ordinal: parseBoundedInteger(attempt.ordinal, `${field}.ordinal`, 1, 1_000_000_000),
    state: attempt.state as TaskGraphAttemptState,
    current: attempt.current,
    model_alias: attempt.model_alias as GraphControlModelAlias,
    resolved_model: displayString(attempt.resolved_model, `${field}.resolved_model`, 256),
    ...(attempt.outcome ? { outcome: attempt.outcome as TaskGraphAttemptOutcome } : {}),
  };
}

function parseNode(value: unknown, index: number): TaskGraphViewNode {
  const field = `nodes[${index}]`;
  const node = record(value, field);
  exactKeys(node, [
    "id",
    "title",
    "goal",
    "current_context",
    "assignee",
    "state",
    "waiting_on_task_ids",
    "activity_cursor",
    "first_activity_at",
    "last_activity_at",
    "model_alias",
    "attempts_started",
    "display_attempt",
    "failure_reason",
  ], field);
  if (!NODE_STATE.has(node.state as TaskGraphNodeState)) throw new Error(`${field}.state is invalid.`);
  if (!Array.isArray(node.waiting_on_task_ids)) throw new Error(`${field}.waiting_on_task_ids must be an array.`);
  const waiting = node.waiting_on_task_ids.map((taskId, taskIndex) =>
    identityString(taskId, `${field}.waiting_on_task_ids[${taskIndex}]`, 128));
  if (new Set(waiting).size !== waiting.length) throw new Error(`${field} contains duplicate waiting Task IDs.`);
  const state = node.state as TaskGraphNodeState;
  if ((state === "dependency_waiting") !== (waiting.length > 0)) {
    throw new Error(`${field} must name waiting Tasks exactly when state is dependency_waiting.`);
  }
  if (node.model_alias !== undefined && !MODEL_ALIAS.has(node.model_alias as GraphControlModelAlias)) {
    throw new Error(`${field}.model_alias is invalid.`);
  }
  if (node.failure_reason !== undefined && !FAILURE_REASON.has(node.failure_reason as TaskGraphFailureReason)) {
    throw new Error(`${field}.failure_reason is invalid.`);
  }
  if ((state === "goal_failed") !== (node.failure_reason !== undefined)) {
    throw new Error(`${field} must include failure_reason exactly when state is goal_failed.`);
  }
  const attemptsStarted = node.attempts_started === undefined
    ? undefined
    : parseBoundedInteger(node.attempts_started, `${field}.attempts_started`, 0, 1_000_000_000);
  const displayAttempt = node.display_attempt === undefined
    ? undefined
    : parseAttempt(node.display_attempt, `${field}.display_attempt`);
  if (displayAttempt && attemptsStarted !== undefined && displayAttempt.ordinal > attemptsStarted) {
    throw new Error(`${field}.display_attempt ordinal exceeds attempts_started.`);
  }
  const firstActivityAt = node.first_activity_at === undefined
    ? undefined
    : isoInstant(node.first_activity_at, `${field}.first_activity_at`);
  const lastActivityAt = node.last_activity_at === undefined
    ? undefined
    : isoInstant(node.last_activity_at, `${field}.last_activity_at`);
  if ((firstActivityAt === undefined) !== (lastActivityAt === undefined)) {
    throw new Error(`${field} must include first_activity_at and last_activity_at together.`);
  }
  if (firstActivityAt && lastActivityAt && Date.parse(lastActivityAt) < Date.parse(firstActivityAt)) {
    throw new Error(`${field}.last_activity_at cannot be before first_activity_at.`);
  }
  return {
    id: identityString(node.id, `${field}.id`, 128),
    title: displayString(node.title, `${field}.title`, 256),
    ...(node.goal === undefined ? {} : { goal: displayString(node.goal, `${field}.goal`, 1_000) }),
    ...(node.current_context === undefined ? {} : { current_context: displayString(node.current_context, `${field}.current_context`, 2_000) }),
    ...(node.assignee === undefined ? {} : { assignee: displayString(node.assignee, `${field}.assignee`, 128) }),
    state,
    waiting_on_task_ids: waiting,
    activity_cursor: parseCursor(node.activity_cursor, `${field}.activity_cursor`),
    ...(firstActivityAt ? { first_activity_at: firstActivityAt, last_activity_at: lastActivityAt! } : {}),
    ...(node.model_alias === undefined ? {} : { model_alias: node.model_alias as GraphControlModelAlias }),
    ...(attemptsStarted === undefined ? {} : { attempts_started: attemptsStarted }),
    ...(displayAttempt ? { display_attempt: displayAttempt } : {}),
    ...(node.failure_reason === undefined ? {} : { failure_reason: node.failure_reason as TaskGraphFailureReason }),
  };
}

function parseEdge(value: unknown, index: number): TaskGraphViewEdge {
  const field = `edges[${index}]`;
  const edge = record(value, field);
  exactKeys(edge, ["from_task_id", "to_task_id", "kind", "traversals", "max_traversals"], field);
  if (!EDGE_KIND.has(edge.kind as TaskGraphEdgeKind)) throw new Error(`${field}.kind is invalid.`);
  const kind = edge.kind as TaskGraphEdgeKind;
  const parsed: TaskGraphViewEdge = {
    from_task_id: identityString(edge.from_task_id, `${field}.from_task_id`, 128),
    to_task_id: identityString(edge.to_task_id, `${field}.to_task_id`, 128),
    kind,
  };
  if (kind === "goal_failed") {
    const maximum = parseBoundedInteger(edge.max_traversals, `${field}.max_traversals`, 1, 8);
    const traversals = parseBoundedInteger(edge.traversals, `${field}.traversals`, 0, maximum);
    parsed.traversals = traversals;
    parsed.max_traversals = maximum;
  } else if (edge.traversals !== undefined || edge.max_traversals !== undefined) {
    throw new Error(`${field} can include traversal bounds only for a goal_failed edge.`);
  }
  if (kind !== "goal_failed" && parsed.from_task_id === parsed.to_task_id) {
    throw new Error(`${field} contains a success dependency self-cycle.`);
  }
  return parsed;
}

/** Validate an ephemeral graph transport before rendering it. */
export function parseTaskGraphViewSource(value: unknown): TaskGraphViewSource {
  const source = record(value, "Task graph source");
  exactKeys(source, ["schema", "team_name", "authority", "source_revision", "graph_version", "authority_sequence", "nodes", "edges"], "Task graph source");
  if (source.schema !== TASK_GRAPH_VIEW_SCHEMA) throw new Error("Task graph source schema is unsupported.");
  if (!SOURCE_AUTHORITY.has(source.authority as TaskGraphSourceAuthority)) throw new Error("Task graph source authority is invalid.");
  const authority = source.authority as TaskGraphSourceAuthority;
  const teamName = identityString(source.team_name, "team_name", 128);
  const sourceRevision = identityString(source.source_revision, "source_revision", 160);
  const graphVersion = source.graph_version === undefined
    ? undefined
    : identityString(source.graph_version, "graph_version", 64);
  const authoritySequence = source.authority_sequence === undefined
    ? undefined
    : parseCursor(source.authority_sequence, "authority_sequence");
  if ((authority === "graph_control") !== (graphVersion !== undefined && authoritySequence !== undefined)) {
    throw new Error("graph_version and authority_sequence are required exactly for a graph_control source.");
  }
  if (!Array.isArray(source.nodes) || source.nodes.length > TASK_GRAPH_MAX_NODES) {
    throw new Error(`nodes must be an array with at most ${TASK_GRAPH_MAX_NODES} items.`);
  }
  if (!Array.isArray(source.edges) || source.edges.length > TASK_GRAPH_MAX_EDGES) {
    throw new Error(`edges must be an array with at most ${TASK_GRAPH_MAX_EDGES} items.`);
  }

  const nodes = source.nodes.map(parseNode).sort(compareRecent);
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) throw new Error(`Task graph source contains duplicate node ${JSON.stringify(node.id)}.`);
    nodeIds.add(node.id);
    if (authority === "graph_control") {
      if (node.state === "legacy_completed" || node.model_alias === undefined || node.attempts_started === undefined
        || node.goal === undefined || node.current_context === undefined) {
        throw new Error(`Graph-control Task ${node.id} lacks graph-control state, detail, model alias, or Attempt count.`);
      }
    } else if (node.model_alias !== undefined || node.attempts_started !== undefined || node.display_attempt !== undefined
      || node.failure_reason !== undefined || ["goal_failed", "goal_achieved", "cancelled"].includes(node.state)) {
      throw new Error(`Legacy Task ${node.id} contains unsupported graph-control meaning.`);
    }
  }

  const edges = source.edges.map(parseEdge);
  const edgeIds = new Set<string>();
  const incomingDependencies = new Set<string>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.from_task_id) || !nodeIds.has(edge.to_task_id)) {
      throw new Error(`Task graph edge ${edge.from_task_id} -> ${edge.to_task_id} has a dangling endpoint.`);
    }
    if (authority === "graph_control" && edge.kind === "legacy_dependency") {
      throw new Error("A graph-control source cannot contain a legacy dependency edge.");
    }
    if (authority === "legacy_task_cards" && edge.kind !== "legacy_dependency") {
      throw new Error("A legacy Task-card source cannot certify a graph-control outcome edge.");
    }
    const key = edgeKey(edge);
    if (edgeIds.has(key)) throw new Error(`Task graph source contains duplicate ${edge.kind} edge ${edge.from_task_id} -> ${edge.to_task_id}.`);
    edgeIds.add(key);
    if (edge.kind !== "goal_failed") incomingDependencies.add(dependencyKey(edge.from_task_id, edge.to_task_id));
  }
  for (const node of nodes) {
    for (const blocker of node.waiting_on_task_ids) {
      if (!incomingDependencies.has(dependencyKey(blocker, node.id))) {
        throw new Error(`Task ${node.id} names waiting Task ${blocker} without a matching dependency edge.`);
      }
    }
  }
  assertSuccessAcyclic(nodes, edges);
  return {
    schema: TASK_GRAPH_VIEW_SCHEMA,
    team_name: teamName,
    authority,
    source_revision: sourceRevision,
    ...(graphVersion ? { graph_version: graphVersion } : {}),
    ...(authoritySequence ? { authority_sequence: authoritySequence } : {}),
    nodes,
    edges: [...edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
  };
}

export function parseTaskGraphViewSourceJson(raw: string): TaskGraphViewSource {
  if (Buffer.byteLength(raw, "utf8") > TASK_GRAPH_MAX_SOURCE_BYTES) {
    throw new Error(`Task graph source exceeds ${TASK_GRAPH_MAX_SOURCE_BYTES} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Task graph source is not valid JSON.");
  }
  return parseTaskGraphViewSource(value);
}

interface ParsedTaskGraphActivity {
  cursor: string;
  firstActivityAt?: string;
  lastActivityAt?: string;
}

function activityCoordinates(
  activity: TaskGraphActivityProjection,
  taskIds: ReadonlySet<string>,
): { headCursor: string; byTask: Map<string, ParsedTaskGraphActivity> } {
  const headCursor = parseCursor(activity.headCursor, "activity.headCursor");
  const byTask = new Map<string, ParsedTaskGraphActivity>();
  for (const [index, coordinate] of activity.tasks.entries()) {
    const taskId = identityString(coordinate.taskId, `activity.tasks[${index}].taskId`, 128);
    const cursor = parseCursor(coordinate.cursor, `activity.tasks[${index}].cursor`);
    const firstActivityAt = coordinate.firstActivityAt === undefined
      ? undefined
      : isoInstant(coordinate.firstActivityAt, `activity.tasks[${index}].firstActivityAt`);
    const lastActivityAt = coordinate.lastActivityAt === undefined
      ? undefined
      : isoInstant(coordinate.lastActivityAt, `activity.tasks[${index}].lastActivityAt`);
    if ((firstActivityAt === undefined) !== (lastActivityAt === undefined)) {
      throw new Error(`activity.tasks[${index}] must include firstActivityAt and lastActivityAt together.`);
    }
    if (firstActivityAt && lastActivityAt && Date.parse(lastActivityAt) < Date.parse(firstActivityAt)) {
      throw new Error(`activity.tasks[${index}].lastActivityAt cannot be before firstActivityAt.`);
    }
    // Historical activity can name a Task removed by the current graph
    // revision. It remains evidence but is outside this current projection.
    if (!taskIds.has(taskId)) continue;
    if (byTask.has(taskId)) throw new Error(`Activity projection contains duplicate Task ${JSON.stringify(taskId)}.`);
    byTask.set(taskId, { cursor, ...(firstActivityAt ? { firstActivityAt, lastActivityAt } : {}) });
  }
  return { headCursor, byTask };
}

function sourceRevision(input: {
  authority: TaskGraphSourceAuthority;
  graphVersion?: string;
  authoritySequence?: string;
  headCursor: string;
  nodes: readonly TaskGraphViewNode[];
  edges: readonly TaskGraphViewEdge[];
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      authority: input.authority,
      graphVersion: input.graphVersion ?? null,
      authoritySequence: input.authoritySequence ?? null,
      nodes: [...input.nodes].sort((left, right) => left.id.localeCompare(right.id)),
      edges: [...input.edges].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right))),
    }))
    .digest("hex")
    .slice(0, 16);
  return `${input.headCursor}-${digest}`;
}

function legacyState(task: TaskCard): { state: TaskGraphNodeState; waiting: string[] } {
  const dependency = task.dependency_state;
  if (!dependency) throw new Error(`Task ${task.id} has no canonical dependency state.`);
  const terminal = task.status === "closed" || task.status === "blocked";
  if (terminal !== (dependency.kind === "terminal")) {
    throw new Error(`Task ${task.id} has contradictory status and dependency state.`);
  }
  if (task.status === "in_progress") return { state: "in_progress", waiting: [] };
  if (task.status === "blocked") return { state: "blocked", waiting: [] };
  if (task.status === "closed") return { state: "legacy_completed", waiting: [] };
  return dependency.kind === "waiting"
    ? { state: "dependency_waiting", waiting: [...dependency.active_blocker_ids] }
    : { state: "ready", waiting: [] };
}

/**
 * Keep the command usable before graph-control persistence is integrated.
 * A legacy closed record remains unresolved completion; it is never relabeled
 * as goal_achieved.
 */
export function projectTaskGraphViewSource(input: {
  teamName: string;
  tasks: readonly TaskCard[];
  activity: TaskGraphActivityProjection;
}): TaskGraphViewSource {
  if (input.tasks.length > TASK_GRAPH_MAX_NODES) throw new Error(`Task graph has more than ${TASK_GRAPH_MAX_NODES} Tasks.`);
  const taskIds = new Set(input.tasks.map((task) => task.id));
  if (taskIds.size !== input.tasks.length) throw new Error("Canonical Task read contains duplicate Task IDs.");
  const activity = activityCoordinates(input.activity, taskIds);
  const nodes: TaskGraphViewNode[] = input.tasks.map((task) => {
    const projected = legacyState(task);
    const coordinate = activity.byTask.get(task.id);
    return {
      id: task.id,
      title: task.title,
      ...("goal" in task ? { goal: task.goal } : {}),
      current_context: task.current_context,
      ...(task.assignee ? { assignee: task.assignee } : {}),
      state: projected.state,
      waiting_on_task_ids: projected.waiting,
      activity_cursor: coordinate?.cursor ?? "0",
      ...(coordinate?.firstActivityAt ? {
        first_activity_at: coordinate.firstActivityAt,
        last_activity_at: coordinate.lastActivityAt!,
      } : {}),
    };
  });
  const edges: TaskGraphViewEdge[] = [];
  for (const task of input.tasks) {
    for (const relation of task.relations ?? []) {
      if (relation.relation !== "blocked_by") continue;
      edges.push({ from_task_id: relation.target_task_id, to_task_id: task.id, kind: "legacy_dependency" });
    }
  }
  if (edges.length > TASK_GRAPH_MAX_EDGES) throw new Error(`Task graph has more than ${TASK_GRAPH_MAX_EDGES} edges.`);
  const revision = sourceRevision({ authority: "legacy_task_cards", headCursor: activity.headCursor, nodes, edges });
  return parseTaskGraphViewSource({
    schema: TASK_GRAPH_VIEW_SCHEMA,
    team_name: input.teamName,
    authority: "legacy_task_cards",
    source_revision: revision,
    nodes,
    edges,
  });
}

function graphControlSequence(trace: TaskGraphControlTrace): number {
  const revision = trace.graphRevisions.at(-1);
  return trace.events.reduce((maximum, event) => Math.max(maximum, event.sequence), revision?.sequence ?? 0);
}

function graphControlActivity(trace: TaskGraphControlTrace): TaskGraphActivityProjection {
  const revision = trace.graphRevisions.at(-1);
  if (!revision) return { headCursor: "0", tasks: [] };
  const attemptTask = new Map(trace.attempts.map((attempt) => [attempt.id, attempt.taskId]));
  const activity = new Map(revision.tasks.map((task) => [task.key, revision.sequence]));
  const mark = (taskId: string | undefined, sequence: number): void => {
    if (taskId && activity.has(taskId)) activity.set(taskId, Math.max(activity.get(taskId) ?? 0, sequence));
  };
  for (const event of trace.events) {
    if ("taskId" in event) mark(event.taskId, event.sequence);
    if ("attemptId" in event && typeof event.attemptId === "string") mark(attemptTask.get(event.attemptId), event.sequence);
    if ("sourceTaskId" in event) mark(event.sourceTaskId, event.sequence);
    if ("targetTaskId" in event) mark(event.targetTaskId, event.sequence);
  }
  return {
    headCursor: String(graphControlSequence(trace)),
    tasks: [...activity].map(([taskId, cursor]) => ({ taskId, cursor: String(cursor) })),
  };
}

function displayAttempt(task: GraphTaskView, attempts: readonly GraphAttemptView[]): GraphAttemptView | undefined {
  const stateAttemptId = "attemptId" in task.state ? task.state.attemptId : undefined;
  const current = stateAttemptId ? attempts.find((attempt) => attempt.id === stateAttemptId) : undefined;
  if (current) return current;
  return attempts.reduce<GraphAttemptView | undefined>((latest, attempt) =>
    !latest || attempt.ordinal > latest.ordinal || (attempt.ordinal === latest.ordinal && attempt.id > latest.id)
      ? attempt
      : latest, undefined);
}

/** Project the executable graph-control trace into the narrow human transport. */
export function projectGraphControlTaskGraphViewSource(input: {
  teamName: string;
  trace: TaskGraphControlTrace;
  activity?: TaskGraphActivityProjection;
}): TaskGraphViewSource {
  const revision = input.trace.graphRevisions.at(-1);
  if (!revision) throw new Error("Graph control has no current graph revision.");
  if (input.trace.tasks.length > TASK_GRAPH_MAX_NODES) throw new Error(`Task graph has more than ${TASK_GRAPH_MAX_NODES} Tasks.`);
  if (input.trace.attempts.length > TASK_GRAPH_MAX_ATTEMPTS) throw new Error(`Task graph has more than ${TASK_GRAPH_MAX_ATTEMPTS} Attempts in its render trace.`);
  if (input.trace.events.length > TASK_GRAPH_MAX_EVENTS) throw new Error(`Task graph has more than ${TASK_GRAPH_MAX_EVENTS} control events in its render trace.`);

  const taskIds = new Set(input.trace.tasks.map((task) => task.id));
  if (taskIds.size !== input.trace.tasks.length) throw new Error("Graph-control read contains duplicate Task IDs.");
  const activity = activityCoordinates(input.activity ?? graphControlActivity(input.trace), taskIds);
  const attemptsByTask = new Map<string, GraphAttemptView[]>();
  for (const attempt of input.trace.attempts) {
    const attempts = attemptsByTask.get(attempt.taskId) ?? [];
    attempts.push(attempt);
    attemptsByTask.set(attempt.taskId, attempts);
  }

  const currentLineage = new Map(revision.tasks.map((task) => [task.key, task.lineage]));
  const failureTraversals = new Map<string, number>();
  for (const event of input.trace.events) {
    if (event.kind !== "failure_edge_traversed" || currentLineage.get(event.sourceTaskId) !== event.sourceTaskLineage) continue;
    const key = dependencyKey(event.sourceTaskId, event.targetTaskId);
    failureTraversals.set(key, (failureTraversals.get(key) ?? 0) + 1);
  }

  const nodes: TaskGraphViewNode[] = input.trace.tasks.map((task) => {
    const attempt = displayAttempt(task, attemptsByTask.get(task.id) ?? []);
    return {
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      state: task.state.kind,
      waiting_on_task_ids: task.state.kind === "dependency_waiting" ? [...task.state.prerequisiteTaskIds] : [],
      goal: task.goal,
      current_context: task.currentContext,
      activity_cursor: activity.byTask.get(task.id)?.cursor ?? "0",
      ...(activity.byTask.get(task.id)?.firstActivityAt ? {
        first_activity_at: activity.byTask.get(task.id)!.firstActivityAt,
        last_activity_at: activity.byTask.get(task.id)!.lastActivityAt!,
      } : {}),
      model_alias: task.modelAlias,
      attempts_started: task.attemptsStarted,
      ...(attempt ? {
        display_attempt: {
          id: attempt.id,
          ordinal: attempt.ordinal,
          state: attempt.state,
          current: attempt.current,
          model_alias: attempt.modelAlias,
          resolved_model: attempt.resolvedModel,
          ...(attempt.outcome ? { outcome: attempt.outcome } : {}),
        },
      } : {}),
      ...(task.state.kind === "goal_failed" ? { failure_reason: task.state.reason } : {}),
    };
  });
  const edges: TaskGraphViewEdge[] = [];
  for (const task of revision.tasks) {
    for (const prerequisite of task.needs) {
      edges.push({ from_task_id: prerequisite, to_task_id: task.key, kind: "goal_achieved" });
    }
    if (task.onGoalFailed) {
      edges.push({
        from_task_id: task.key,
        to_task_id: task.onGoalFailed.target,
        kind: "goal_failed",
        traversals: failureTraversals.get(dependencyKey(task.key, task.onGoalFailed.target)) ?? 0,
        max_traversals: task.onGoalFailed.maxTraversals,
      });
    }
  }
  if (edges.length > TASK_GRAPH_MAX_EDGES) throw new Error(`Task graph has more than ${TASK_GRAPH_MAX_EDGES} edges.`);
  const authoritySequence = String(graphControlSequence(input.trace));
  const sourceRevisionValue = sourceRevision({
    authority: "graph_control",
    graphVersion: revision.version,
    authoritySequence,
    headCursor: activity.headCursor,
    nodes,
    edges,
  });
  return parseTaskGraphViewSource({
    schema: TASK_GRAPH_VIEW_SCHEMA,
    team_name: input.teamName,
    authority: "graph_control",
    source_revision: sourceRevisionValue,
    graph_version: revision.version,
    authority_sequence: authoritySequence,
    nodes,
    edges,
  });
}

function stateMatchesFilter(state: TaskGraphNodeState, filter: TaskGraphStateFilter): boolean {
  if (filter === "all") return true;
  if (filter === "actionable") return ["ready", "in_progress", "blocked", "goal_failed"].includes(state);
  if (filter === "nonterminal") return !["goal_achieved", "cancelled", "legacy_completed"].includes(state);
  return state === "goal_failed" || state === "blocked";
}

/** Apply an explicit human-only state filter, then select bounded recent matches. */
export function selectVisibleTaskGraph(
  source: TaskGraphViewSource,
  limit: TaskGraphRecentLimit,
  stateFilter: TaskGraphStateFilter = "all",
): VisibleTaskGraph {
  const matching = source.nodes.filter((node) => stateMatchesFilter(node.state, stateFilter));
  const count = limit === "all" ? matching.length : limit;
  const nodes = matching.slice(0, count);
  const visible = new Set(nodes.map((node) => node.id));
  const edges = source.edges.filter((edge) => visible.has(edge.from_task_id) && visible.has(edge.to_task_id));
  const boundaryEdgeCount = source.edges.filter((edge) => visible.has(edge.from_task_id) !== visible.has(edge.to_task_id)).length;
  const incoming = new Map<string, number>();
  for (const edge of source.edges) {
    if (edge.kind !== "goal_failed") incoming.set(edge.to_task_id, (incoming.get(edge.to_task_id) ?? 0) + 1);
  }
  const recencyOmittedNodeCount = matching.length - nodes.length;
  const filterOmittedNodeCount = source.nodes.length - matching.length;
  return {
    source,
    limit,
    stateFilter,
    nodes,
    edges,
    joinTaskIds: new Set(nodes.filter((node) => (incoming.get(node.id) ?? 0) > 1).map((node) => node.id)),
    omittedNodeCount: recencyOmittedNodeCount + filterOmittedNodeCount,
    recencyOmittedNodeCount,
    filterOmittedNodeCount,
    boundaryEdgeCount,
  };
}

export function parseTaskGraphLimit(input: string): TaskGraphRecentLimit {
  const value = input.trim().toLowerCase();
  if (!value) return TASK_GRAPH_DEFAULT_LIMIT;
  if (value === "all") return "all";
  const numeric = Number(value);
  if (TASK_GRAPH_LIMITS.includes(numeric as (typeof TASK_GRAPH_LIMITS)[number])) {
    return numeric as (typeof TASK_GRAPH_LIMITS)[number];
  }
  throw new Error(`Task graph limit must be one of ${TASK_GRAPH_LIMITS.join(", ")}, or all.`);
}
