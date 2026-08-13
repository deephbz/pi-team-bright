import { createHash } from "node:crypto";

export type TaskStatus = "open" | "in_progress" | "blocked" | "closed";

export type NewTaskRef = { key: string };
export type ExistingTaskRef = { task_id: string; expected_version?: string };
export type TaskRef = NewTaskRef | ExistingTaskRef;

export interface TaskGraphNode {
  key: string;
  title: string;
  goal: string;
  assignee?: string;
}

export interface TaskGraphDependency {
  task: NewTaskRef | Required<ExistingTaskRef>;
  needs: TaskRef[];
}

export interface TaskGraphCreateInput {
  operation_id: string;
  tasks: TaskGraphNode[];
  dependencies?: TaskGraphDependency[];
}

export interface ExistingTask {
  id: string;
  version: string;
  status: TaskStatus;
}

export interface GraphTaskState {
  id: string;
  key?: string;
  title: string;
  goal: string;
  status: TaskStatus;
  assignee?: string;
  version: string;
  blockedBy: string[];
}

export type DependencyReadiness =
  | { kind: "ready"; active_blocker_ids: [] }
  | { kind: "waiting"; active_blocker_ids: string[] }
  | { kind: "terminal"; active_blocker_ids: string[] };

export interface GraphValidationContext {
  workers?: ReadonlySet<string>;
  existingTasks?: ReadonlyMap<string, ExistingTask>;
}

export type GraphValidationCode =
  | "duplicate_key"
  | "operation_conflict"
  | "unknown_key"
  | "missing_task"
  | "version_conflict"
  | "worker_unavailable"
  | "self_dependency"
  | "duplicate_dependency"
  | "cycle";

export class TaskGraphValidationError extends Error {
  constructor(readonly code: GraphValidationCode, message: string, readonly coordinates: string[] = []) {
    super(message);
    this.name = "TaskGraphValidationError";
  }
}

export interface CompiledGraphPlan {
  nodes: Array<{
    key: string;
    title: string;
    description: string;
    acceptance_criteria?: string;
    assignee?: string;
    labels?: string[];
    metadata?: Record<string, unknown>;
  }>;
  edges: Array<{
    from_key?: string;
    from_id?: string;
    to_key?: string;
    to_id?: string;
    type: "blocks";
  }>;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stable(nested)]));
}

export function taskGraphFingerprint(input: TaskGraphCreateInput): string {
  return createHash("sha256").update(JSON.stringify(stable({
    operation_id: input.operation_id,
    tasks: input.tasks,
    dependencies: input.dependencies ?? [],
  }))).digest("hex");
}

function refCoordinate(ref: TaskRef): string {
  return "key" in ref ? `key:${ref.key}` : `task:${ref.task_id}`;
}

function resolveRef(ref: TaskRef, keyIds: ReadonlyMap<string, string>): string {
  if ("key" in ref) {
    const id = keyIds.get(ref.key);
    if (!id) throw new TaskGraphValidationError("unknown_key", `Dependency refers to unknown Task key ${ref.key}.`, [ref.key]);
    return id;
  }
  return ref.task_id;
}

/** Validate all graph semantics before an adapter can start an authority write. */
export function validateTaskGraph(input: TaskGraphCreateInput, context: GraphValidationContext = {}): void {
  const keys = new Set<string>();
  for (const task of input.tasks) {
    if (keys.has(task.key)) throw new TaskGraphValidationError("duplicate_key", `Task key ${task.key} occurs more than once.`, [task.key]);
    keys.add(task.key);
    if (!task.assignee) throw new TaskGraphValidationError("worker_unavailable", `Task ${task.key} requires one current Worker assignee.`, [task.key]);
    if (context.workers && !context.workers.has(task.assignee)) {
      throw new TaskGraphValidationError("worker_unavailable", `Assigned Worker ${task.assignee} is not current.`, [task.assignee]);
    }
  }

  const existing = context.existingTasks;
  const assertRef = (ref: TaskRef, dependent: boolean): void => {
    if ("key" in ref) {
      if (!keys.has(ref.key)) throw new TaskGraphValidationError("unknown_key", `Dependency refers to unknown Task key ${ref.key}.`, [ref.key]);
      return;
    }
    if (!existing) return;
    const task = existing.get(ref.task_id);
    if (!task) throw new TaskGraphValidationError("missing_task", `Existing Task ${ref.task_id} was not found.`, [ref.task_id]);
    if (dependent) {
      const expected = (ref as ExistingTaskRef).expected_version;
      if (!expected || expected !== task.version) {
        throw new TaskGraphValidationError("version_conflict", `Existing dependent Task ${ref.task_id} changed; read it and retry.`, [ref.task_id]);
      }
    }
  };

  const edgeSet = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const dependency of input.dependencies ?? []) {
    assertRef(dependency.task, true);
    const from = refCoordinate(dependency.task);
    for (const need of dependency.needs) {
      assertRef(need, false);
      const to = refCoordinate(need);
      if (from === to) throw new TaskGraphValidationError("self_dependency", `Task ${from} cannot need itself.`, [from]);
      const edge = `${from}\u0000${to}`;
      if (edgeSet.has(edge)) throw new TaskGraphValidationError("duplicate_dependency", `Dependency ${from} needs ${to} occurs more than once.`, [from, to]);
      edgeSet.add(edge);
      adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string, path: string[]): void => {
    if (visiting.has(node)) {
      const start = path.indexOf(node);
      const cycle = [...path.slice(start), node];
      throw new TaskGraphValidationError("cycle", `Task dependency cycle: ${cycle.join(" -> ")}.`, cycle);
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) visit(next, [...path, node]);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of adjacency.keys()) visit(node, []);
}

/** Compile model terms to the Beads graph-plan direction without leaking it upward. */
export function compileBeadsGraphPlan(
  input: TaskGraphCreateInput,
  options: {
    teamLabel?: string;
    nodeMetadata?: (task: TaskGraphNode, fingerprint: string) => Record<string, unknown>;
  } = {},
): CompiledGraphPlan {
  validateTaskGraph(input);
  const fingerprint = taskGraphFingerprint(input);
  const ref = (value: TaskRef, side: "from" | "to") => "key" in value
    ? { [`${side}_key`]: value.key }
    : { [`${side}_id`]: value.task_id };
  return {
    nodes: input.tasks.map((task) => ({
      key: task.key,
      title: task.title,
      description: task.goal,
      ...(task.assignee ? { acceptance_criteria: task.goal, assignee: task.assignee } : {}),
      ...(options.teamLabel ? { labels: [options.teamLabel] } : {}),
      ...(options.nodeMetadata ? { metadata: options.nodeMetadata(task, fingerprint) } : {}),
    })),
    edges: (input.dependencies ?? []).flatMap((dependency) => dependency.needs.map((need) => ({
      ...ref(dependency.task, "from"),
      ...ref(need, "to"),
      type: "blocks" as const,
    }))),
  };
}

export function dependencyReadiness(task: Pick<GraphTaskState, "status" | "blockedBy">, tasks: ReadonlyMap<string, Pick<GraphTaskState, "status">>): DependencyReadiness {
  const active = task.blockedBy.filter((id) => tasks.get(id)?.status !== "closed").sort();
  if (task.status === "closed" || task.status === "blocked") return { kind: "terminal", active_blocker_ids: active };
  return active.length === 0
    ? { kind: "ready", active_blocker_ids: [] }
    : { kind: "waiting", active_blocker_ids: active };
}

export interface DeliveryCoordinate {
  taskId: string;
  taskVersion: string;
  worker: string;
  state: "pending" | "presented";
}

/** Select at most one stable ready Task for each free Worker. */
export function selectDispatchFrontier(
  tasks: readonly GraphTaskState[],
  deliveries: readonly DeliveryCoordinate[],
  initiallyOccupiedWorkers: readonly string[] = [],
): GraphTaskState[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const occupied = new Set<string>(initiallyOccupiedWorkers);
  const deliveredVersions = new Set<string>();
  for (const delivery of deliveries) {
    occupied.add(delivery.worker);
    deliveredVersions.add(`${delivery.taskId}\u0000${delivery.taskVersion}`);
  }
  for (const task of tasks) if (task.status === "in_progress" && task.assignee) occupied.add(task.assignee);

  const selected: GraphTaskState[] = [];
  for (const task of [...tasks].sort((left, right) => left.id.localeCompare(right.id))) {
    if (task.status !== "open" || !task.assignee || occupied.has(task.assignee)) continue;
    if (deliveredVersions.has(`${task.id}\u0000${task.version}`)) continue;
    if (dependencyReadiness(task, byId).kind !== "ready") continue;
    selected.push(task);
    occupied.add(task.assignee);
  }
  return selected;
}

export function activeBlockerIds(task: GraphTaskState, tasks: ReadonlyMap<string, GraphTaskState>): string[] {
  return dependencyReadiness(task, tasks).active_blocker_ids;
}
