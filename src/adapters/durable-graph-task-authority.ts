import fs from "node:fs";
import {
  GraphControlRefusal,
  GraphTaskController,
  type GraphApplyInput,
  type GraphApplyResult,
  type GraphAttemptView,
  type GraphControlSnapshot,
  type GraphTaskTransitionInput,
  type GraphVersionRef,
  type GraphTransitionResult,
} from "../task-authority/graph-control";
import type { GraphTaskCard } from "../task-authority/graph-control-schemas";
import { writeJsonAtomic } from "../utils/atomic-json";
import { withLock } from "../utils/lock";
import { graphTaskAuthorityPath } from "../utils/paths";

export interface GraphAuthorityMutation<Result> {
  result: Result & { replayed: boolean };
  /** Monotonic graph-revision sequence after the mutation. */
  graphSequence: number;
  /** Monotonic graph event/revision sequence after the mutation. */
  authoritySequence: number;
  graphVersion: GraphVersionRef;
  before: GraphTaskCard[];
  after: GraphTaskCard[];
  ready: GraphTaskCard[];
}

function toCard(task: ReturnType<GraphTaskController["readTask"]>, attempts: GraphAttemptView[]): GraphTaskCard {
  const currentAttempt = attempts.find((attempt) => attempt.current);
  const prerequisiteIds = task.state.kind === "dependency_waiting"
    ? task.state.prerequisiteTaskIds
    : task.state.kind === "goal_failed" && "prerequisiteTaskIds" in task.state
      ? task.state.prerequisiteTaskIds
      : [];
  const terminal = ["goal_achieved", "goal_failed", "cancelled"].includes(task.state.kind);
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    assignee: task.assignee,
    needs: [...task.needs],
    ...(task.onGoalFailed ? { on_goal_failed: { target: task.onGoalFailed.target, max_traversals: task.onGoalFailed.maxTraversals } } : {}),
    status: task.state.kind,
    state: task.state.kind === "dependency_waiting"
      ? { kind: "dependency_waiting", prerequisite_task_ids: [...task.state.prerequisiteTaskIds] }
      : task.state.kind === "in_progress"
        ? { kind: "in_progress", attempt_id: task.state.attemptId }
        : task.state.kind === "blocked"
          ? { kind: "blocked", attempt_id: task.state.attemptId, evidence: task.state.evidence }
          : task.state.kind === "goal_achieved"
            ? { kind: "goal_achieved", attempt_id: task.state.attemptId }
            : task.state.kind === "goal_failed" && task.state.reason === "criterion_failed"
              ? { kind: "goal_failed", reason: "criterion_failed", attempt_id: task.state.attemptId }
              : task.state.kind === "goal_failed" && task.state.reason === "failure_edge_exhausted"
                ? {
                  kind: "goal_failed",
                  reason: "failure_edge_exhausted",
                  attempt_id: task.state.attemptId,
                  target_task_id: task.state.targetTaskId,
                  traversals: task.state.traversals,
                  exhaustion_reason: task.state.exhaustionReason,
                }
                : task.state.kind === "goal_failed"
                  ? { kind: "goal_failed", reason: task.state.reason, prerequisite_task_ids: [...task.state.prerequisiteTaskIds] }
                  : task.state.kind === "cancelled"
                    ? { kind: "cancelled", reason: task.state.reason }
                    : { kind: "ready" },
    current_context: task.currentContext,
    version: task.version,
    ...(task.activationKey ? { activation_key: task.activationKey } : {}),
    ...(task.acceptedAttemptId ? { accepted_attempt_id: task.acceptedAttemptId } : {}),
    ...(currentAttempt ? {
      current_attempt: {
        id: currentAttempt.id,
        ordinal: currentAttempt.ordinal,
        input_attempt_ids: { ...currentAttempt.inputAttemptIds },
      },
    } : {}),
    attempts_started: task.attemptsStarted,
    relations: task.needs.map((target_task_id) => ({ relation: "blocked_by" as const, target_task_id })),
    dependency_state: terminal || task.state.kind === "blocked"
      ? { kind: "terminal", active_blocker_ids: prerequisiteIds }
      : prerequisiteIds.length
        ? { kind: "waiting", active_blocker_ids: prerequisiteIds }
        : { kind: "ready", active_blocker_ids: [] },
  };
}

function cards(controller: GraphTaskController): GraphTaskCard[] {
  const attempts = controller.readAttempts();
  return controller.readTasks().map((task) => toCard(task, attempts.filter((attempt) => attempt.taskId === task.id)));
}

/** Team-scoped durable composition around the backend-neutral controller. */
export class DurableGraphTaskAuthority {

  exists(teamName: string): boolean {
    return fs.existsSync(graphTaskAuthorityPath(teamName));
  }

  async applyGraph(teamName: string, input: GraphApplyInput): Promise<GraphAuthorityMutation<GraphApplyResult>> {
    return this.mutate(teamName, (controller) => controller.applyGraph(input));
  }

  async transition(teamName: string, input: GraphTaskTransitionInput): Promise<GraphAuthorityMutation<GraphTransitionResult>> {
    return this.mutate(teamName, (controller) => controller.transition(input));
  }

  async readTasks(teamName: string, taskIds?: readonly string[]): Promise<GraphTaskCard[]> {
    return withLock(graphTaskAuthorityPath(teamName), async () => {
      const controller = this.loadRequired(teamName);
      const all = cards(controller);
      if (!taskIds) return all;
      const byId = new Map(all.map((task) => [task.id, task]));
      return taskIds.flatMap((taskId) => byId.get(taskId) ?? []);
    });
  }

  async readTask(teamName: string, taskId: string): Promise<GraphTaskCard | undefined> {
    return (await this.readTasks(teamName, [taskId]))[0];
  }

  async readyFrontier(teamName: string, worker?: string): Promise<GraphTaskCard[]> {
    return withLock(graphTaskAuthorityPath(teamName), async () => {
      const controller = this.loadRequired(teamName);
      const byId = new Map(cards(controller).map((task) => [task.id, task]));
      return controller.selectReadyFrontier()
        .flatMap((task) => byId.get(task.id) ?? [])
        .filter((task) => !worker || task.assignee === worker);
    });
  }

  async trace(teamName: string): Promise<ReturnType<GraphTaskController["trace"]>> {
    return withLock(graphTaskAuthorityPath(teamName), async () => this.loadRequired(teamName).trace());
  }

  private async mutate<Result extends GraphApplyResult | GraphTransitionResult>(
    teamName: string,
    apply: (controller: GraphTaskController) => Result & { replayed: boolean },
  ): Promise<GraphAuthorityMutation<Result>> {
    const file = graphTaskAuthorityPath(teamName);
    return withLock(file, async () => {
      const controller = this.load(teamName);
      const before = cards(controller);
      const result = apply(controller);
      writeJsonAtomic(file, controller.snapshot());
      const after = cards(controller);
      const readyIds = new Set(controller.selectReadyFrontier().map((task) => task.id));
      const trace = controller.trace();
      const revision = trace.graphRevisions.at(-1);
      const graphSequence = revision?.sequence;
      if (!revision || graphSequence === undefined) throw new GraphControlRefusal("invalid_graph", "Committed graph has no current revision sequence.");
      const authoritySequence = Math.max(
        graphSequence,
        ...trace.events.map((event) => event.sequence),
      );
      return { result, graphSequence, authoritySequence, graphVersion: revision.version, before, after, ready: after.filter((task) => readyIds.has(task.id)) };
    });
  }

  private loadRequired(teamName: string): GraphTaskController {
    if (!this.exists(teamName)) throw new GraphControlRefusal("invalid_graph", `Team ${teamName} has no graph-native Task authority snapshot.`);
    return this.load(teamName);
  }

  private load(teamName: string): GraphTaskController {
    const file = graphTaskAuthorityPath(teamName);
    if (!fs.existsSync(file)) return new GraphTaskController();
    let snapshot: GraphControlSnapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as GraphControlSnapshot;
    } catch (error) {
      throw new GraphControlRefusal("invalid_graph", `Graph authority snapshot cannot be decoded: ${error instanceof Error ? error.message : String(error)}`);
    }
    const legacyModelFields = snapshot as unknown as {
      modelAliases?: unknown;
      graphRevisions?: Array<{ tasks?: Array<Record<string, unknown>> }>;
      events?: Array<Record<string, unknown>>;
    };
    if (legacyModelFields.modelAliases !== undefined
      || legacyModelFields.graphRevisions?.some((revision) => revision.tasks?.some((task) => task.modelAlias !== undefined || task.model !== undefined))
      || legacyModelFields.events?.some((event) => event.kind === "attempt_started" && (event.modelAlias !== undefined || event.resolvedModel !== undefined))) {
      throw new GraphControlRefusal("invalid_graph", "Graph authority snapshot contains removed Task model selection fields; migration is not supported.");
    }
    return GraphTaskController.recover(snapshot);
  }
}
