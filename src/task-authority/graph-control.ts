import { createHash } from "node:crypto";
import { taskVersionRef, type TaskVersionRef } from "./task-version-ref";

/**
 * Executable first contract for graph-native Task control.
 *
 * The transition design is owned by
 * docs/projects/dag-native/graph-control-transition-spec.json.
 * This module has no Beads, Pi, delivery, or presentation dependency.
 */

export const GRAPH_CONTROL_MAX_FAILURE_TRAVERSALS = 8;
export const GRAPH_CONTROL_MODEL_ALIASES = ["default", "capable"] as const;
export const GRAPH_CONTROL_TASK_STATES = [
  "dependency_waiting",
  "ready",
  "in_progress",
  "blocked",
  "goal_failed",
  "goal_achieved",
  "cancelled",
] as const;

export type GraphControlModelAlias = typeof GRAPH_CONTROL_MODEL_ALIASES[number];
export type GraphVersionRef = `g_${string}`;
export type GraphTaskOutcome = "goal_achieved" | "goal_failed";
export type GraphTaskTransition =
  | "claim"
  | "block"
  | "resume"
  | "goal_achieved"
  | "goal_failed"
  | "cancel";

export interface GraphControlModelAliases {
  default: string;
  capable: string;
}

export interface GraphFailureEdge {
  target: string;
  maxTraversals: number;
}

export interface GraphTaskDefinitionInput {
  key: string;
  title: string;
  goal: string;
  assignee: string;
  modelAlias?: GraphControlModelAlias;
  needs?: string[];
  onGoalFailed?: GraphFailureEdge;
}

export interface GraphApplyInput {
  operationId: string;
  expectedGraphVersion?: GraphVersionRef;
  tasks: GraphTaskDefinitionInput[];
}

export interface GraphTaskTransitionInput {
  taskId: string;
  operationId: string;
  expectedVersion: TaskVersionRef;
  transition?: GraphTaskTransition;
  worker?: string;
  currentContext?: string;
  evidence?: string;
}

export type GraphGoalFailure =
  | { reason: "criterion_failed"; attemptId: string }
  | { reason: "failure_edge_exhausted"; attemptId: string; targetTaskId: string; traversals: number; exhaustionReason: "limit_reached" | "target_cancelled" }
  | { reason: "dependency_failed"; prerequisiteTaskIds: string[] }
  | { reason: "dependency_cancelled"; prerequisiteTaskIds: string[] };

export type GraphTaskState =
  | { kind: "dependency_waiting"; prerequisiteTaskIds: string[] }
  | { kind: "ready" }
  | { kind: "in_progress"; attemptId: string }
  | { kind: "blocked"; attemptId: string; evidence: string }
  | ({ kind: "goal_failed" } & GraphGoalFailure)
  | { kind: "goal_achieved"; attemptId: string }
  | { kind: "cancelled"; reason: string };

export interface GraphTaskView {
  id: string;
  title: string;
  goal: string;
  assignee: string;
  modelAlias: GraphControlModelAlias;
  needs: string[];
  onGoalFailed?: GraphFailureEdge;
  state: GraphTaskState;
  currentContext: string;
  version: TaskVersionRef;
  activationKey?: string;
  acceptedAttemptId?: string;
  attemptsStarted: number;
}

export interface GraphAttemptView {
  id: string;
  taskId: string;
  ordinal: number;
  graphVersion: GraphVersionRef;
  taskLineage: string;
  activationKey: string;
  inputAttemptIds: Record<string, string>;
  assignee: string;
  modelAlias: GraphControlModelAlias;
  resolvedModel: string;
  state: "in_progress" | "blocked" | "completed" | "superseded" | "cancelled";
  current: boolean;
  outcome?: GraphTaskOutcome;
  evidence?: string;
}

interface StoredTaskDefinition extends Omit<GraphTaskDefinitionInput, "modelAlias" | "needs" | "onGoalFailed"> {
  modelAlias: GraphControlModelAlias;
  needs: string[];
  onGoalFailed?: GraphFailureEdge;
  lineage: string;
}

export interface GraphRevision {
  sequence: number;
  version: GraphVersionRef;
  tasks: StoredTaskDefinition[];
}

interface AttemptStartedEvent {
  kind: "attempt_started";
  sequence: number;
  operationId: string;
  attemptId: string;
  taskId: string;
  ordinal: number;
  graphVersion: GraphVersionRef;
  taskLineage: string;
  activationKey: string;
  inputAttemptIds: Record<string, string>;
  assignee: string;
  modelAlias: GraphControlModelAlias;
  resolvedModel: string;
}

interface AttemptBlockedEvent {
  kind: "attempt_blocked";
  sequence: number;
  operationId: string;
  attemptId: string;
  evidence: string;
}

interface AttemptResumedEvent {
  kind: "attempt_resumed";
  sequence: number;
  operationId: string;
  attemptId: string;
}

interface AttemptCompletedEvent {
  kind: "attempt_completed";
  sequence: number;
  operationId: string;
  attemptId: string;
  outcome: GraphTaskOutcome;
  evidence: string;
}

interface AttemptSupersededEvent {
  kind: "attempt_superseded";
  sequence: number;
  operationId: string;
  attemptId: string;
  reason: "graph_revised" | "repair_requested" | "dependency_cancelled";
}

interface TaskCancelledEvent {
  kind: "task_cancelled";
  sequence: number;
  operationId: string;
  taskId: string;
  taskLineage: string;
  attemptId?: string;
  reason: string;
}

interface TaskContextUpdatedEvent {
  kind: "task_context_updated";
  sequence: number;
  operationId: string;
  taskId: string;
  taskLineage: string;
  currentContext: string;
}

interface FailureEdgeTraversedEvent {
  kind: "failure_edge_traversed";
  sequence: number;
  operationId: string;
  sourceTaskId: string;
  sourceTaskLineage: string;
  sourceAttemptId: string;
  targetTaskId: string;
  targetTaskLineage: string;
  traversal: number;
}

interface FailureEdgeExhaustedEvent {
  kind: "failure_edge_exhausted";
  sequence: number;
  operationId: string;
  sourceTaskId: string;
  sourceTaskLineage: string;
  sourceAttemptId: string;
  targetTaskId: string;
  traversals: number;
  reason: "limit_reached" | "target_cancelled";
}

export type GraphControlEvent =
  | AttemptStartedEvent
  | AttemptBlockedEvent
  | AttemptResumedEvent
  | AttemptCompletedEvent
  | AttemptSupersededEvent
  | TaskCancelledEvent
  | TaskContextUpdatedEvent
  | FailureEdgeTraversedEvent
  | FailureEdgeExhaustedEvent;

type GraphControlEventInput = GraphControlEvent extends infer Event
  ? Event extends GraphControlEvent
    ? Omit<Event, "sequence">
    : never
  : never;

export interface GraphApplyResult {
  kind: "graph_applied";
  operationId: string;
  graphVersion: GraphVersionRef;
  tasks: GraphTaskView[];
  readyTaskIds: string[];
}

export interface GraphTransitionResult {
  kind: "task_transitioned";
  operationId: string;
  transition: GraphTaskTransition | "context_updated";
  task: GraphTaskView;
  readyTaskIds: string[];
  failureTraversal?: { sourceTaskId: string; targetTaskId: string; traversal: number };
}

export type GraphControlResult = GraphApplyResult | GraphTransitionResult;
export type GraphControlReceipt = GraphControlResult & { replayed: boolean };

interface StoredReceipt {
  operationId: string;
  fingerprint: string;
  result: GraphControlResult;
}

export interface GraphControlSnapshot {
  schema: "pi-team-bright-graph-control/1";
  graphRevisions: GraphRevision[];
  events: GraphControlEvent[];
  receipts: StoredReceipt[];
}

export interface GraphControlDurableSnapshot extends GraphControlSnapshot {
  modelAliases: GraphControlModelAliases;
}

export class GraphControlRefusal extends Error {
  constructor(
    readonly code:
      | "invalid_graph"
      | "graph_version_conflict"
      | "task_not_found"
      | "task_version_conflict"
      | "operation_conflict"
      | "invalid_transition"
      | "worker_mismatch"
      | "worker_occupied"
      | "evidence_required"
      | "model_alias_unresolved",
    message: string,
  ) {
    super(message);
    this.name = "GraphControlRefusal";
  }
}

interface AttemptFold {
  started: AttemptStartedEvent;
  blocked?: AttemptBlockedEvent;
  resumed?: AttemptResumedEvent;
  completed?: AttemptCompletedEvent;
  superseded?: AttemptSupersededEvent;
  cancellation?: TaskCancelledEvent;
}

interface DerivedTask {
  definition: StoredTaskDefinition;
  state: GraphTaskState;
  activationKey?: string;
  inputAttemptIds: Record<string, string>;
  acceptedAttemptId?: string;
  attemptsStarted: number;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonical(nested)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireText(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new GraphControlRefusal("evidence_required", `${label} must not be empty.`);
  return value;
}

function graphVersion(value: unknown): GraphVersionRef {
  return `g_${digest(value).slice(0, 16)}`;
}

function semanticDefinition(definition: Omit<StoredTaskDefinition, "lineage">): unknown {
  return {
    key: definition.key,
    title: definition.title,
    goal: definition.goal,
    assignee: definition.assignee,
    modelAlias: definition.modelAlias,
    needs: definition.needs,
    onGoalFailed: definition.onGoalFailed ?? null,
  };
}

/**
 * Small event-backed reference authority for deterministic Task graph control.
 * External work is a transition command; all graph movement runs synchronously
 * before that command returns.
 */
export class GraphTaskController {
  private readonly graphRevisions: GraphRevision[];
  private readonly events: GraphControlEvent[];
  private readonly receipts: Map<string, StoredReceipt>;

  constructor(
    private readonly modelAliases: GraphControlModelAliases,
    snapshot?: GraphControlSnapshot,
  ) {
    for (const alias of GRAPH_CONTROL_MODEL_ALIASES) {
      if (!modelAliases[alias]?.trim()) {
        throw new GraphControlRefusal("model_alias_unresolved", `Model alias ${alias} has no configured model.`);
      }
    }
    if (snapshot && snapshot.schema !== "pi-team-bright-graph-control/1") {
      throw new GraphControlRefusal("invalid_graph", `Unsupported snapshot schema ${String(snapshot.schema)}.`);
    }
    this.graphRevisions = clone(snapshot?.graphRevisions ?? []);
    this.events = clone(snapshot?.events ?? []);
    this.receipts = new Map((snapshot?.receipts ?? []).map(receipt => [receipt.operationId, clone(receipt)]));
  }

  static recover(snapshot: GraphControlSnapshot, modelAliases: GraphControlModelAliases): GraphTaskController {
    validateSnapshot(snapshot);
    return new GraphTaskController(modelAliases, snapshot);
  }

  snapshot(): GraphControlSnapshot {
    return {
      schema: "pi-team-bright-graph-control/1",
      graphRevisions: clone(this.graphRevisions),
      events: clone(this.events),
      receipts: [...this.receipts.values()].map(clone),
    };
  }

  durableSnapshot(): GraphControlDurableSnapshot {
    return { ...this.snapshot(), modelAliases: clone(this.modelAliases) };
  }

  currentGraphVersion(): GraphVersionRef | undefined {
    return this.currentRevision()?.version;
  }

  applyGraph(input: GraphApplyInput): GraphApplyResult & { replayed: boolean } {
    return this.command(input.operationId, { command: "apply_graph", ...input }, () => {
      const priorRevision = this.currentRevision();
      if (!priorRevision && input.expectedGraphVersion !== undefined) {
        throw new GraphControlRefusal("graph_version_conflict", "The first graph apply must not include an expected version.");
      }
      if (priorRevision && input.expectedGraphVersion !== priorRevision.version) {
        throw new GraphControlRefusal(
          "graph_version_conflict",
          `Graph changed; expected ${String(input.expectedGraphVersion)}, current ${priorRevision.version}.`,
        );
      }

      const normalized = normalizeAndValidate(input.tasks);
      const priorById = new Map((priorRevision?.tasks ?? []).map(task => [task.key, task]));
      const revisionSequence = this.nextSequence();
      const tasks: StoredTaskDefinition[] = normalized.map(definition => {
        const prior = priorById.get(definition.key);
        const sameMeaning = prior && digest(semanticDefinition(prior)) === digest(semanticDefinition(definition));
        return {
          ...definition,
          lineage: sameMeaning
            ? prior.lineage
            : digest({ task: semanticDefinition(definition), introducedAt: revisionSequence }),
        };
      });
      const version = graphVersion({ previous: priorRevision?.version ?? null, tasks });

      const attemptsBefore = this.readAttempts();
      const activeBefore = new Map(attemptsBefore
        .filter(attempt => attempt.state === "in_progress" || attempt.state === "blocked")
        .map(attempt => [attempt.taskId, attempt.id]));
      const nextById = new Map(tasks.map(task => [task.key, task]));
      const directlyChanged = new Set<string>();
      for (const [taskId, prior] of priorById) {
        if (nextById.get(taskId)?.lineage !== prior.lineage) directlyChanged.add(taskId);
      }
      for (const [taskId, next] of nextById) {
        if (priorById.get(taskId)?.lineage !== next.lineage) directlyChanged.add(taskId);
      }
      const affected = new Set([
        ...reverseClosure([...directlyChanged], priorRevision?.tasks ?? []),
        ...reverseClosure([...directlyChanged], tasks),
      ]);

      this.graphRevisions.push({ sequence: revisionSequence, version, tasks });
      for (const taskId of [...affected].sort()) {
        const attemptId = activeBefore.get(taskId)
          ?? attemptsBefore.findLast(attempt => attempt.taskId === taskId && attempt.current)?.id;
        if (attemptId) this.append({
          kind: "attempt_superseded",
          operationId: input.operationId,
          attemptId,
          reason: "graph_revised",
        });
      }

      const currentTasks = this.readTasks();
      return {
        kind: "graph_applied",
        operationId: input.operationId,
        graphVersion: version,
        tasks: currentTasks,
        readyTaskIds: readyIds(currentTasks),
      };
    });
  }

  transition(input: GraphTaskTransitionInput): GraphTransitionResult & { replayed: boolean } {
    return this.command(input.operationId, { command: "transition", ...input }, () => {
      const task = this.readTask(input.taskId);
      if (task.version !== input.expectedVersion) {
        throw new GraphControlRefusal(
          "task_version_conflict",
          `Task ${task.id} changed; expected ${input.expectedVersion}, current ${task.version}.`,
        );
      }
      if (!input.transition && !input.currentContext?.trim()) {
        throw new GraphControlRefusal("invalid_transition", "A Task command requires a transition or nonempty current context.");
      }

      let failureTraversal: GraphTransitionResult["failureTraversal"];
      switch (input.transition) {
        case "claim":
          this.claim(task, input);
          break;
        case "block":
          this.block(task, input);
          break;
        case "resume":
          this.resume(task, input);
          break;
        case "goal_achieved":
        case "goal_failed":
          failureTraversal = this.complete(task, input);
          break;
        case "cancel":
          this.cancel(task, input);
          break;
      }
      if (input.currentContext?.trim()) {
        this.append({
          kind: "task_context_updated",
          operationId: input.operationId,
          taskId: task.id,
          taskLineage: this.definition(task.id).lineage,
          currentContext: input.currentContext,
        });
      }

      const tasks = this.readTasks();
      return {
        kind: "task_transitioned",
        operationId: input.operationId,
        transition: input.transition ?? "context_updated",
        task: tasks.find(candidate => candidate.id === input.taskId)!,
        readyTaskIds: readyIds(tasks),
        ...(failureTraversal ? { failureTraversal } : {}),
      };
    });
  }

  readTask(taskId: string): GraphTaskView {
    const derived = this.derive().get(taskId);
    if (!derived) throw new GraphControlRefusal("task_not_found", `Task ${taskId} is not in the current graph.`);
    return this.toView(derived);
  }

  readTasks(): GraphTaskView[] {
    return [...this.derive().values()].map(task => this.toView(task)).sort((left, right) => left.id.localeCompare(right.id));
  }

  readAttempts(taskId?: string): GraphAttemptView[] {
    const currentTaskIds = new Set(this.currentRevision()?.tasks.map(task => task.key) ?? []);
    const currentAttemptIds = new Set(this.readTasks().flatMap(task => {
      if (task.state.kind === "in_progress" || task.state.kind === "blocked" || task.state.kind === "goal_achieved") {
        return [task.state.attemptId];
      }
      if (task.state.kind === "goal_failed" && "attemptId" in task.state) return [task.state.attemptId];
      return [];
    }));
    return [...this.attemptFolds().values()]
      .filter(attempt => !taskId || attempt.started.taskId === taskId)
      .sort((left, right) => left.started.sequence - right.started.sequence)
      .map(attempt => {
        const blocked = attempt.blocked && (!attempt.resumed || attempt.blocked.sequence > attempt.resumed.sequence);
        const staleLineage = !currentTaskIds.has(attempt.started.taskId)
          || this.definition(attempt.started.taskId).lineage !== attempt.started.taskLineage;
        const state: GraphAttemptView["state"] = attempt.completed
          ? "completed"
          : attempt.cancellation
            ? "cancelled"
            : attempt.superseded || staleLineage
              ? "superseded"
              : blocked
                ? "blocked"
                : "in_progress";
        return {
          id: attempt.started.attemptId,
          taskId: attempt.started.taskId,
          ordinal: attempt.started.ordinal,
          graphVersion: attempt.started.graphVersion,
          taskLineage: attempt.started.taskLineage,
          activationKey: attempt.started.activationKey,
          inputAttemptIds: clone(attempt.started.inputAttemptIds),
          assignee: attempt.started.assignee,
          modelAlias: attempt.started.modelAlias,
          resolvedModel: attempt.started.resolvedModel,
          state,
          current: currentAttemptIds.has(attempt.started.attemptId),
          ...(attempt.completed ? { outcome: attempt.completed.outcome, evidence: attempt.completed.evidence } : {}),
          ...(blocked ? { evidence: attempt.blocked!.evidence } : {}),
        };
      });
  }

  selectReadyFrontier(): GraphTaskView[] {
    const occupied = new Set(this.readTasks().flatMap(task => task.state.kind === "in_progress" ? [task.assignee] : []));
    const selected: GraphTaskView[] = [];
    for (const task of this.readTasks()) {
      if (task.state.kind !== "ready" || occupied.has(task.assignee)) continue;
      selected.push(task);
      occupied.add(task.assignee);
    }
    return selected;
  }

  trace(): { graphRevisions: GraphRevision[]; tasks: GraphTaskView[]; attempts: GraphAttemptView[]; events: GraphControlEvent[] } {
    return {
      graphRevisions: clone(this.graphRevisions),
      tasks: this.readTasks(),
      attempts: this.readAttempts(),
      events: clone(this.events),
    };
  }

  private claim(task: GraphTaskView, input: GraphTaskTransitionInput): void {
    if (task.state.kind !== "ready") this.invalid(task, "claim");
    this.assertWorker(task, input);
    const occupied = this.readTasks().find(candidate => candidate.assignee === task.assignee && candidate.state.kind === "in_progress");
    if (occupied) {
      throw new GraphControlRefusal("worker_occupied", `Worker ${task.assignee} already has in-progress Task ${occupied.id}.`);
    }
    const derived = this.derive().get(task.id)!;
    const revision = this.currentRevision()!;
    const ordinal = derived.attemptsStarted + 1;
    this.append({
      kind: "attempt_started",
      operationId: input.operationId,
      attemptId: `${task.id}@${ordinal}`,
      taskId: task.id,
      ordinal,
      graphVersion: revision.version,
      taskLineage: derived.definition.lineage,
      activationKey: derived.activationKey!,
      inputAttemptIds: clone(derived.inputAttemptIds),
      assignee: task.assignee,
      modelAlias: task.modelAlias,
      resolvedModel: this.modelAliases[task.modelAlias],
    });
  }

  private block(task: GraphTaskView, input: GraphTaskTransitionInput): void {
    if (task.state.kind !== "in_progress") this.invalid(task, "block");
    this.assertWorker(task, input);
    this.append({
      kind: "attempt_blocked",
      operationId: input.operationId,
      attemptId: task.state.attemptId,
      evidence: requireText(input.evidence, "Blocker evidence"),
    });
  }

  private resume(task: GraphTaskView, input: GraphTaskTransitionInput): void {
    if (task.state.kind !== "blocked") this.invalid(task, "resume");
    this.assertWorker(task, input);
    const occupied = this.readTasks().find(candidate => candidate.assignee === task.assignee && candidate.state.kind === "in_progress");
    if (occupied) {
      throw new GraphControlRefusal("worker_occupied", `Worker ${task.assignee} already has in-progress Task ${occupied.id}.`);
    }
    this.append({
      kind: "attempt_resumed",
      operationId: input.operationId,
      attemptId: task.state.attemptId,
    });
  }

  private complete(task: GraphTaskView, input: GraphTaskTransitionInput): GraphTransitionResult["failureTraversal"] {
    if (task.state.kind !== "in_progress") this.invalid(task, input.transition ?? "complete");
    this.assertWorker(task, input);
    const evidence = requireText(input.evidence, "Goal outcome evidence");
    this.append({
      kind: "attempt_completed",
      operationId: input.operationId,
      attemptId: task.state.attemptId,
      outcome: input.transition as GraphTaskOutcome,
      evidence,
    });
    if (input.transition === "goal_achieved") return undefined;

    const definition = this.definition(task.id);
    const edge = definition.onGoalFailed;
    if (!edge) return undefined;
    const priorTraversals = this.events.filter((event): event is FailureEdgeTraversedEvent =>
      event.kind === "failure_edge_traversed"
      && event.sourceTaskId === task.id
      && event.sourceTaskLineage === definition.lineage).length;
    if (priorTraversals >= edge.maxTraversals) {
      this.append({
        kind: "failure_edge_exhausted",
        operationId: input.operationId,
        sourceTaskId: task.id,
        sourceTaskLineage: definition.lineage,
        sourceAttemptId: task.state.attemptId,
        targetTaskId: edge.target,
        traversals: priorTraversals,
        reason: "limit_reached",
      });
      return undefined;
    }

    const target = this.definition(edge.target);
    const targetCancelled = this.events.findLast((event): event is TaskCancelledEvent =>
      event.kind === "task_cancelled"
      && event.taskId === edge.target
      && event.taskLineage === target.lineage);
    if (targetCancelled) {
      this.append({
        kind: "failure_edge_exhausted",
        operationId: input.operationId,
        sourceTaskId: task.id,
        sourceTaskLineage: definition.lineage,
        sourceAttemptId: task.state.attemptId,
        targetTaskId: edge.target,
        traversals: priorTraversals,
        reason: "target_cancelled",
      });
      return undefined;
    }
    const attemptsBefore = this.readAttempts();
    const activeBefore = new Map(attemptsBefore
      .filter(attempt => attempt.state === "in_progress" || attempt.state === "blocked")
      .map(attempt => [attempt.taskId, attempt.id]));
    const traversal = priorTraversals + 1;
    this.append({
      kind: "failure_edge_traversed",
      operationId: input.operationId,
      sourceTaskId: task.id,
      sourceTaskLineage: definition.lineage,
      sourceAttemptId: task.state.attemptId,
      targetTaskId: edge.target,
      targetTaskLineage: target.lineage,
      traversal,
    });
    for (const affectedTaskId of reverseClosure([edge.target], this.currentRevision()!.tasks)) {
      const attemptId = activeBefore.get(affectedTaskId)
        ?? attemptsBefore.findLast(attempt => attempt.taskId === affectedTaskId && attempt.current)?.id;
      if (attemptId && attemptId !== task.state.attemptId) this.append({
        kind: "attempt_superseded",
        operationId: input.operationId,
        attemptId,
        reason: "repair_requested",
      });
    }
    return { sourceTaskId: task.id, targetTaskId: edge.target, traversal };
  }

  private cancel(task: GraphTaskView, input: GraphTaskTransitionInput): void {
    if (!["dependency_waiting", "ready", "in_progress", "blocked"].includes(task.state.kind)) this.invalid(task, "cancel");
    if (input.worker !== undefined) this.assertWorker(task, input);
    const reason = requireText(input.evidence, "Cancellation reason");
    const attemptId = task.state.kind === "in_progress" || task.state.kind === "blocked" ? task.state.attemptId : undefined;
    const activeBefore = new Map(this.readAttempts()
      .filter(attempt => attempt.state === "in_progress" || attempt.state === "blocked")
      .map(attempt => [attempt.taskId, attempt.id]));
    this.append({
      kind: "task_cancelled",
      operationId: input.operationId,
      taskId: task.id,
      taskLineage: this.definition(task.id).lineage,
      ...(attemptId ? { attemptId } : {}),
      reason,
    });
    for (const affectedTaskId of reverseClosure([task.id], this.currentRevision()!.tasks)) {
      const affectedAttemptId = activeBefore.get(affectedTaskId);
      if (affectedAttemptId && affectedAttemptId !== attemptId) this.append({
        kind: "attempt_superseded",
        operationId: input.operationId,
        attemptId: affectedAttemptId,
        reason: "dependency_cancelled",
      });
    }
  }

  private assertWorker(task: GraphTaskView, input: GraphTaskTransitionInput): void {
    if (input.worker !== task.assignee) {
      throw new GraphControlRefusal("worker_mismatch", `Task ${task.id} is assigned to ${task.assignee}, not ${String(input.worker)}.`);
    }
    if (task.state.kind === "in_progress" || task.state.kind === "blocked") {
      const attemptId = task.state.attemptId;
      const attempt = this.readAttempts(task.id).find(candidate => candidate.id === attemptId);
      if (attempt?.assignee !== input.worker) {
        throw new GraphControlRefusal("worker_mismatch", `Attempt ${attemptId} belongs to Worker ${String(attempt?.assignee)}.`);
      }
    }
  }

  private invalid(task: GraphTaskView, transition: string): never {
    throw new GraphControlRefusal("invalid_transition", `Task ${task.id} is ${task.state.kind}; ${transition} is not valid.`);
  }

  private command<Result extends GraphControlResult>(operationId: string, semantics: unknown, apply: () => Result): Result & { replayed: boolean } {
    if (!operationId.trim()) throw new GraphControlRefusal("operation_conflict", "Operation identity must not be empty.");
    const fingerprint = digest(semantics);
    const prior = this.receipts.get(operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new GraphControlRefusal("operation_conflict", `Operation ${operationId} was already used with different semantics.`);
      }
      return { ...clone(prior.result as Result), replayed: true };
    }

    const graphLength = this.graphRevisions.length;
    const eventLength = this.events.length;
    const receiptSize = this.receipts.size;
    try {
      const result = apply();
      this.receipts.set(operationId, { operationId, fingerprint, result: clone(result) });
      return { ...clone(result), replayed: false };
    } catch (error) {
      this.graphRevisions.length = graphLength;
      this.events.length = eventLength;
      if (this.receipts.size !== receiptSize) this.receipts.delete(operationId);
      throw error;
    }
  }

  private append(event: GraphControlEventInput): void {
    this.events.push({ ...event, sequence: this.nextSequence() } as GraphControlEvent);
  }

  private nextSequence(): number {
    return Math.max(
      0,
      ...this.graphRevisions.map(revision => revision.sequence),
      ...this.events.map(event => event.sequence),
    ) + 1;
  }

  private currentRevision(): GraphRevision | undefined {
    return this.graphRevisions.at(-1);
  }

  private definition(taskId: string): StoredTaskDefinition {
    const definition = this.currentRevision()?.tasks.find(task => task.key === taskId);
    if (!definition) throw new GraphControlRefusal("task_not_found", `Task ${taskId} is not in the current graph.`);
    return definition;
  }

  private attemptFolds(): Map<string, AttemptFold> {
    const attempts = new Map<string, AttemptFold>();
    for (const event of this.events) {
      if (event.kind === "attempt_started") attempts.set(event.attemptId, { started: event });
      else if ("attemptId" in event && event.attemptId) {
        const attempt = attempts.get(event.attemptId);
        if (!attempt) continue;
        if (event.kind === "attempt_blocked") attempt.blocked = event;
        else if (event.kind === "attempt_resumed") attempt.resumed = event;
        else if (event.kind === "attempt_completed") attempt.completed = event;
        else if (event.kind === "attempt_superseded") attempt.superseded = event;
        else if (event.kind === "task_cancelled") attempt.cancellation = event;
      }
    }
    return attempts;
  }

  private derive(): Map<string, DerivedTask> {
    const revision = this.currentRevision();
    if (!revision) return new Map();
    const order = topologicalOrder(revision.tasks);
    const attempts = [...this.attemptFolds().values()];
    const result = new Map<string, DerivedTask>();

    for (const taskId of order) {
      const definition = revision.tasks.find(task => task.key === taskId)!;
      const taskAttempts = attempts.filter(attempt => attempt.started.taskId === taskId);
        const cancellation = this.events.findLast((event): event is TaskCancelledEvent =>
        event.kind === "task_cancelled"
        && event.taskId === taskId
        && event.taskLineage === definition.lineage);
      const failedPrerequisites: string[] = [];
      const cancelledPrerequisites: string[] = [];
      const waitingPrerequisites: string[] = [];
      const inputAttemptIds: Record<string, string> = {};
      for (const prerequisiteId of definition.needs) {
        const prerequisite = result.get(prerequisiteId)!;
        if (prerequisite.state.kind === "goal_achieved") {
          inputAttemptIds[prerequisiteId] = prerequisite.state.attemptId;
        } else if (prerequisite.state.kind === "cancelled") {
          cancelledPrerequisites.push(prerequisiteId);
        } else if (prerequisite.state.kind === "goal_failed") {
          failedPrerequisites.push(prerequisiteId);
        } else {
          waitingPrerequisites.push(prerequisiteId);
        }
      }

      const demand = this.events.filter((event): event is FailureEdgeTraversedEvent =>
        event.kind === "failure_edge_traversed"
        && event.targetTaskId === taskId
        && event.targetTaskLineage === definition.lineage).length;
      let state: GraphTaskState;
      let activationKey: string | undefined;
      let acceptedAttemptId: string | undefined;
      if (cancellation) {
        state = { kind: "cancelled", reason: cancellation.reason };
      } else if (cancelledPrerequisites.length) {
        state = { kind: "goal_failed", reason: "dependency_cancelled", prerequisiteTaskIds: cancelledPrerequisites.sort() };
      } else if (failedPrerequisites.length) {
        state = { kind: "goal_failed", reason: "dependency_failed", prerequisiteTaskIds: failedPrerequisites.sort() };
      } else if (waitingPrerequisites.length) {
        state = { kind: "dependency_waiting", prerequisiteTaskIds: waitingPrerequisites.sort() };
      } else {
        activationKey = digest({ taskLineage: definition.lineage, demand, inputAttemptIds });
        const current = taskAttempts.findLast(attempt =>
          attempt.started.taskLineage === definition.lineage
          && attempt.started.activationKey === activationKey
          && !attempt.superseded
          && !attempt.cancellation);
        if (!current) {
          state = { kind: "ready" };
        } else if (!current.completed) {
          const blocked = current.blocked && (!current.resumed || current.blocked.sequence > current.resumed.sequence);
          state = blocked
            ? { kind: "blocked", attemptId: current.started.attemptId, evidence: current.blocked!.evidence }
            : { kind: "in_progress", attemptId: current.started.attemptId };
        } else if (current.completed.outcome === "goal_achieved") {
          acceptedAttemptId = current.started.attemptId;
          state = { kind: "goal_achieved", attemptId: acceptedAttemptId };
        } else {
          const exhausted = this.events.findLast((event): event is FailureEdgeExhaustedEvent =>
            event.kind === "failure_edge_exhausted" && event.sourceAttemptId === current.started.attemptId);
          state = exhausted
            ? {
              kind: "goal_failed",
              reason: "failure_edge_exhausted",
              attemptId: current.started.attemptId,
              targetTaskId: exhausted.targetTaskId,
              traversals: exhausted.traversals,
              exhaustionReason: exhausted.reason,
            }
            : { kind: "goal_failed", reason: "criterion_failed", attemptId: current.started.attemptId };
        }
      }
      result.set(taskId, {
        definition,
        state,
        ...(activationKey ? { activationKey } : {}),
        inputAttemptIds,
        ...(acceptedAttemptId ? { acceptedAttemptId } : {}),
        attemptsStarted: taskAttempts.length,
      });
    }
    return result;
  }

  private toView(task: DerivedTask): GraphTaskView {
    const value = {
      id: task.definition.key,
      title: task.definition.title,
      goal: task.definition.goal,
      assignee: task.definition.assignee,
      modelAlias: task.definition.modelAlias,
      needs: clone(task.definition.needs),
      ...(task.definition.onGoalFailed ? { onGoalFailed: clone(task.definition.onGoalFailed) } : {}),
      state: clone(task.state),
      currentContext: this.events.findLast((event): event is TaskContextUpdatedEvent =>
        event.kind === "task_context_updated"
        && event.taskId === task.definition.key
        && event.taskLineage === task.definition.lineage)?.currentContext ?? "Work has not started.",
      ...(task.activationKey ? { activationKey: task.activationKey } : {}),
      ...(task.acceptedAttemptId ? { acceptedAttemptId: task.acceptedAttemptId } : {}),
      attemptsStarted: task.attemptsStarted,
    };
    return { ...value, version: taskVersionRef(JSON.stringify(canonical(value))) };
  }
}

function validateSnapshot(snapshot: GraphControlSnapshot): void {
  if (!snapshot || snapshot.schema !== "pi-team-bright-graph-control/1"
    || !Array.isArray(snapshot.graphRevisions)
    || !Array.isArray(snapshot.events)
    || !Array.isArray(snapshot.receipts)) {
    throw new GraphControlRefusal("invalid_graph", "Graph authority snapshot has an invalid top-level shape.");
  }
  const sequences = [
    ...snapshot.graphRevisions.map((revision) => revision?.sequence),
    ...snapshot.events.map((event) => event?.sequence),
  ];
  if (sequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 1)
    || new Set(sequences).size !== sequences.length) {
    throw new GraphControlRefusal("invalid_graph", "Graph authority snapshot has invalid or duplicate event sequences.");
  }
  for (const revision of snapshot.graphRevisions) {
    if (!revision || typeof revision.version !== "string" || !Array.isArray(revision.tasks)) {
      throw new GraphControlRefusal("invalid_graph", "Graph authority snapshot has an invalid graph revision.");
    }
    const normalized = normalizeAndValidate(revision.tasks.map((task) => ({
      key: task.key,
      title: task.title,
      goal: task.goal,
      assignee: task.assignee,
      modelAlias: task.modelAlias,
      needs: task.needs,
      ...(task.onGoalFailed ? { onGoalFailed: task.onGoalFailed } : {}),
    })));
    if (normalized.length !== revision.tasks.length
      || normalized.some((task) => !revision.tasks.find((stored) => stored.key === task.key)?.lineage?.trim())) {
      throw new GraphControlRefusal("invalid_graph", "Graph authority snapshot has an invalid Task lineage.");
    }
  }
  const operations = new Set<string>();
  for (const receipt of snapshot.receipts) {
    if (!receipt || !receipt.operationId?.trim() || !receipt.fingerprint?.trim() || !receipt.result) {
      throw new GraphControlRefusal("invalid_graph", "Graph authority snapshot has an invalid operation receipt.");
    }
    if (operations.has(receipt.operationId)) {
      throw new GraphControlRefusal("invalid_graph", `Graph authority snapshot repeats operation ${receipt.operationId}.`);
    }
    operations.add(receipt.operationId);
  }
}

function readyIds(tasks: GraphTaskView[]): string[] {
  return tasks.filter(task => task.state.kind === "ready").map(task => task.id).sort();
}

function normalizeAndValidate(input: GraphTaskDefinitionInput[]): Array<Omit<StoredTaskDefinition, "lineage">> {
  if (!input.length) throw new GraphControlRefusal("invalid_graph", "A graph requires at least one Task.");
  const normalized = input.map(task => ({
    key: task.key,
    title: task.title,
    goal: task.goal,
    assignee: task.assignee,
    modelAlias: task.modelAlias ?? "default" as const,
    needs: [...(task.needs ?? [])].sort(),
    ...(task.onGoalFailed ? { onGoalFailed: { ...task.onGoalFailed } } : {}),
  }));
  const byId = new Map<string, typeof normalized[number]>();
  for (const task of normalized) {
    if (!task.key.trim() || !task.title.trim() || !task.goal.trim() || !task.assignee.trim()) {
      throw new GraphControlRefusal("invalid_graph", "Every Task requires nonempty key, title, goal, and assignee values.");
    }
    if (byId.has(task.key)) throw new GraphControlRefusal("invalid_graph", `Task key ${task.key} occurs more than once.`);
    if (!GRAPH_CONTROL_MODEL_ALIASES.includes(task.modelAlias)) {
      throw new GraphControlRefusal("invalid_graph", `Task ${task.key} has unsupported model alias ${String(task.modelAlias)}.`);
    }
    if (new Set(task.needs).size !== task.needs.length) {
      throw new GraphControlRefusal("invalid_graph", `Task ${task.key} repeats a prerequisite.`);
    }
    byId.set(task.key, task);
  }
  for (const task of normalized) {
    for (const prerequisite of task.needs) {
      if (!byId.has(prerequisite)) throw new GraphControlRefusal("invalid_graph", `Task ${task.key} needs missing Task ${prerequisite}.`);
      if (prerequisite === task.key) throw new GraphControlRefusal("invalid_graph", `Task ${task.key} cannot need itself.`);
    }
    if (task.onGoalFailed) {
      if (!Number.isInteger(task.onGoalFailed.maxTraversals)
        || task.onGoalFailed.maxTraversals < 1
        || task.onGoalFailed.maxTraversals > GRAPH_CONTROL_MAX_FAILURE_TRAVERSALS) {
        throw new GraphControlRefusal(
          "invalid_graph",
          `Task ${task.key} failure maxTraversals must be from 1 through ${GRAPH_CONTROL_MAX_FAILURE_TRAVERSALS}.`,
        );
      }
      if (!byId.has(task.onGoalFailed.target)) {
        throw new GraphControlRefusal("invalid_graph", `Task ${task.key} has missing failure target ${task.onGoalFailed.target}.`);
      }
    }
  }
  topologicalOrder(normalized as StoredTaskDefinition[]);
  for (const task of normalized) {
    const target = task.onGoalFailed?.target;
    if (target && target !== task.key && !ancestors(task.key, byId).has(target)) {
      throw new GraphControlRefusal(
        "invalid_graph",
        `Task ${task.key} failure target ${target} must be itself or a transitive success prerequisite.`,
      );
    }
  }
  return normalized;
}

function topologicalOrder(tasks: readonly Pick<StoredTaskDefinition, "key" | "needs">[]): string[] {
  const byId = new Map(tasks.map(task => [task.key, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (taskId: string, path: string[]): void => {
    if (visiting.has(taskId)) {
      throw new GraphControlRefusal("invalid_graph", `Success dependency cycle: ${[...path, taskId].join(" -> ")}.`);
    }
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const prerequisite of byId.get(taskId)?.needs ?? []) visit(prerequisite, [...path, taskId]);
    visiting.delete(taskId);
    visited.add(taskId);
    order.push(taskId);
  };
  for (const taskId of [...byId.keys()].sort()) visit(taskId, []);
  return order;
}

function ancestors<T extends { needs: string[] }>(taskId: string, tasks: ReadonlyMap<string, T>): Set<string> {
  const result = new Set<string>();
  const collect = (id: string): void => {
    for (const prerequisite of tasks.get(id)?.needs ?? []) {
      if (result.has(prerequisite)) continue;
      result.add(prerequisite);
      collect(prerequisite);
    }
  };
  collect(taskId);
  return result;
}

function reverseClosure(seed: string[], tasks: readonly Pick<StoredTaskDefinition, "key" | "needs">[]): Set<string> {
  const result = new Set(seed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (result.has(task.key) || !task.needs.some(prerequisite => result.has(prerequisite))) continue;
      result.add(task.key);
      changed = true;
    }
  }
  return result;
}
