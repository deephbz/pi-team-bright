import { type TaskVersionRef } from "./task-version-ref";
/**
 * Executable first contract for graph-native Task control.
 *
 * The transition design is owned by
 * docs/projects/dag-native/graph-control-transition-spec.json.
 * This module has no Beads, Pi, delivery, or presentation dependency.
 */
export declare const GRAPH_CONTROL_MAX_FAILURE_TRAVERSALS = 8;
export declare const GRAPH_CONTROL_TASK_STATES: readonly ["dependency_waiting", "ready", "in_progress", "blocked", "goal_failed", "goal_achieved", "cancelled"];
export type GraphVersionRef = `g_${string}`;
export type GraphTaskOutcome = "goal_achieved" | "goal_failed";
export type GraphTaskTransition = "claim" | "block" | "resume" | "goal_achieved" | "goal_failed" | "cancel";
export interface GraphFailureEdge {
    target: string;
    maxTraversals: number;
}
export interface GraphTaskDefinitionInput {
    key: string;
    title: string;
    goal: string;
    assignee: string;
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
export type GraphGoalFailure = {
    reason: "criterion_failed";
    attemptId: string;
} | {
    reason: "failure_edge_exhausted";
    attemptId: string;
    targetTaskId: string;
    traversals: number;
    exhaustionReason: "limit_reached" | "target_cancelled";
} | {
    reason: "dependency_failed";
    prerequisiteTaskIds: string[];
} | {
    reason: "dependency_cancelled";
    prerequisiteTaskIds: string[];
};
export type GraphTaskState = {
    kind: "dependency_waiting";
    prerequisiteTaskIds: string[];
} | {
    kind: "ready";
} | {
    kind: "in_progress";
    attemptId: string;
} | {
    kind: "blocked";
    attemptId: string;
    evidence: string;
} | ({
    kind: "goal_failed";
} & GraphGoalFailure) | {
    kind: "goal_achieved";
    attemptId: string;
} | {
    kind: "cancelled";
    reason: string;
};
export interface GraphTaskView {
    id: string;
    title: string;
    goal: string;
    assignee: string;
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
    state: "in_progress" | "blocked" | "completed" | "superseded" | "cancelled";
    current: boolean;
    outcome?: GraphTaskOutcome;
    evidence?: string;
}
interface StoredTaskDefinition extends Omit<GraphTaskDefinitionInput, "needs" | "onGoalFailed"> {
    needs: string[];
    onGoalFailed?: GraphFailureEdge;
    lineage: string;
}
export interface GraphRevision {
    sequence: number;
    version: GraphVersionRef;
    tasks: StoredTaskDefinition[];
    recorded_at?: string;
}
interface RecordedEvent {
    recorded_at?: string;
}
interface AttemptStartedEvent extends RecordedEvent {
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
}
interface AttemptBlockedEvent extends RecordedEvent {
    kind: "attempt_blocked";
    sequence: number;
    operationId: string;
    attemptId: string;
    evidence: string;
}
interface AttemptResumedEvent extends RecordedEvent {
    kind: "attempt_resumed";
    sequence: number;
    operationId: string;
    attemptId: string;
}
interface AttemptCompletedEvent extends RecordedEvent {
    kind: "attempt_completed";
    sequence: number;
    operationId: string;
    attemptId: string;
    outcome: GraphTaskOutcome;
    evidence: string;
}
interface AttemptSupersededEvent extends RecordedEvent {
    kind: "attempt_superseded";
    sequence: number;
    operationId: string;
    attemptId: string;
    reason: "graph_revised" | "repair_requested" | "dependency_cancelled";
}
interface TaskCancelledEvent extends RecordedEvent {
    kind: "task_cancelled";
    sequence: number;
    operationId: string;
    taskId: string;
    taskLineage: string;
    attemptId?: string;
    reason: string;
}
interface TaskContextUpdatedEvent extends RecordedEvent {
    kind: "task_context_updated";
    sequence: number;
    operationId: string;
    taskId: string;
    taskLineage: string;
    currentContext: string;
}
interface FailureEdgeTraversedEvent extends RecordedEvent {
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
interface FailureEdgeExhaustedEvent extends RecordedEvent {
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
export type GraphControlEvent = AttemptStartedEvent | AttemptBlockedEvent | AttemptResumedEvent | AttemptCompletedEvent | AttemptSupersededEvent | TaskCancelledEvent | TaskContextUpdatedEvent | FailureEdgeTraversedEvent | FailureEdgeExhaustedEvent;
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
    failureTraversal?: {
        sourceTaskId: string;
        targetTaskId: string;
        traversal: number;
    };
}
export type GraphControlResult = GraphApplyResult | GraphTransitionResult;
export type GraphControlReceipt = GraphControlResult & {
    replayed: boolean;
};
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
export declare class GraphControlRefusal extends Error {
    readonly code: "invalid_graph" | "graph_version_conflict" | "task_not_found" | "task_version_conflict" | "operation_conflict" | "invalid_transition" | "worker_mismatch" | "worker_occupied" | "evidence_required";
    constructor(code: "invalid_graph" | "graph_version_conflict" | "task_not_found" | "task_version_conflict" | "operation_conflict" | "invalid_transition" | "worker_mismatch" | "worker_occupied" | "evidence_required", message: string);
}
/**
 * Small event-backed reference authority for deterministic Task graph control.
 * External work is a transition command; all graph movement runs synchronously
 * before that command returns.
 */
export declare class GraphTaskController {
    private readonly clock;
    private readonly graphRevisions;
    private readonly events;
    private readonly receipts;
    private commandRecordedAt?;
    private derivedCache?;
    constructor(snapshot?: GraphControlSnapshot, clock?: () => Date);
    static recover(snapshot: GraphControlSnapshot, clock?: () => Date): GraphTaskController;
    snapshot(): GraphControlSnapshot;
    currentGraphVersion(): GraphVersionRef | undefined;
    hasOperationReceipt(operationId: string): boolean;
    applyGraph(input: GraphApplyInput): GraphApplyResult & {
        replayed: boolean;
    };
    transition(input: GraphTaskTransitionInput): GraphTransitionResult & {
        replayed: boolean;
    };
    readTask(taskId: string): GraphTaskView;
    readTasks(): GraphTaskView[];
    readAttempts(taskId?: string): GraphAttemptView[];
    selectReadyFrontier(): GraphTaskView[];
    trace(): {
        graphRevisions: GraphRevision[];
        tasks: GraphTaskView[];
        attempts: GraphAttemptView[];
        events: GraphControlEvent[];
    };
    private claim;
    private block;
    private resume;
    private complete;
    private cancel;
    private assertWorker;
    private invalid;
    private command;
    private append;
    private nextSequence;
    private currentRevision;
    private definition;
    private attemptFolds;
    private derivedGraph;
    private derive;
    private toView;
}
export type GraphTaskReadState = Pick<GraphTaskController, "readTasks" | "readAttempts" | "selectReadyFrontier">;
/** Read-only recovery owns revision reuse. Commit recovery always validates fully.
 * Retain fingerprints only; changed prefixes and failures require full validation.
 */
export declare class GraphObservationRecovery {
    private accepted?;
    recover(snapshot: GraphControlSnapshot): GraphTaskReadState;
    private revisionFingerprint;
    private validateRevision;
}
export {};
