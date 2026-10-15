import type { GraphTaskReadState } from "./graph-control";
import type { GraphTaskCard } from "./graph-control-schemas";

/** Project controller state into the public Task card. */
export function projectGraphTaskCards(controller: GraphTaskReadState): GraphTaskCard[] {
  const attempts = controller.readAttempts();
  return controller.readTasks().map(task => {
    const currentAttempt = attempts.find(attempt => attempt.taskId === task.id && attempt.current);
    const prerequisiteIds = task.state.kind === "dependency_waiting"
      ? task.state.prerequisiteTaskIds
      : task.state.kind === "goal_failed" && "prerequisiteTaskIds" in task.state ? task.state.prerequisiteTaskIds : [];
    const terminal = ["goal_achieved", "goal_failed", "cancelled"].includes(task.state.kind);
    const state: GraphTaskCard["state"] = task.state.kind === "dependency_waiting"
      ? { kind: "dependency_waiting", prerequisite_task_ids: [...task.state.prerequisiteTaskIds] }
      : task.state.kind === "in_progress" ? { kind: "in_progress", attempt_id: task.state.attemptId }
      : task.state.kind === "blocked" ? { kind: "blocked", attempt_id: task.state.attemptId, evidence: task.state.evidence }
      : task.state.kind === "goal_achieved" ? { kind: "goal_achieved", attempt_id: task.state.attemptId }
      : task.state.kind === "goal_failed" && task.state.reason === "criterion_failed"
        ? { kind: "goal_failed", reason: "criterion_failed", attempt_id: task.state.attemptId }
      : task.state.kind === "goal_failed" && task.state.reason === "failure_edge_exhausted"
        ? { kind: "goal_failed", reason: "failure_edge_exhausted", attempt_id: task.state.attemptId,
          target_task_id: task.state.targetTaskId, traversals: task.state.traversals, exhaustion_reason: task.state.exhaustionReason }
      : task.state.kind === "goal_failed"
        ? { kind: "goal_failed", reason: task.state.reason, prerequisite_task_ids: [...task.state.prerequisiteTaskIds] }
      : task.state.kind === "cancelled" ? { kind: "cancelled", reason: task.state.reason }
      : { kind: "ready" };
    return {
      id: task.id, title: task.title, goal: task.goal, assignee: task.assignee, needs: [...task.needs],
      ...(task.onGoalFailed ? { on_goal_failed: { target: task.onGoalFailed.target, max_traversals: task.onGoalFailed.maxTraversals } } : {}),
      status: task.state.kind, state, current_context: task.currentContext, version: task.version,
      ...(task.activationKey ? { activation_key: task.activationKey } : {}),
      ...(task.acceptedAttemptId ? { accepted_attempt_id: task.acceptedAttemptId } : {}),
      ...(currentAttempt ? { current_attempt: { id: currentAttempt.id, ordinal: currentAttempt.ordinal, input_attempt_ids: { ...currentAttempt.inputAttemptIds } } } : {}),
      attempts_started: task.attemptsStarted,
      relations: task.needs.map(target_task_id => ({ relation: "blocked_by" as const, target_task_id })),
      dependency_state: terminal || task.state.kind === "blocked"
        ? { kind: "terminal" as const, active_blocker_ids: prerequisiteIds }
        : prerequisiteIds.length ? { kind: "waiting" as const, active_blocker_ids: prerequisiteIds }
        : { kind: "ready" as const, active_blocker_ids: [] },
    };
  });
}
