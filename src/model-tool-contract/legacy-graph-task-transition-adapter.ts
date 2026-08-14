import { BeadsError } from "../utils/beads";
import type { GraphTaskTransition } from "../task-authority/graph-control";
import type { ModelToolTaskUpdateInput, TaskStatus } from "../task-authority/contracts";
import type { TaskVersionRef } from "../task-authority/task-version-ref";
import type { TaskUpdatePortOutcome } from "./model-tool-contracts";
import type { BeadsTaskAdapter, TaskUpdateOutcome } from "./beads-task-adapter";

/**
 * Bridge the graph-native Worker command surface to a pre-graph Beads Task.
 *
 * A legacy closed Task is only a legacy completion fact. This adapter maps an
 * explicit goal_achieved command to it, but refuses goal_failed and cancel
 * because Beads cannot persist their distinct graph-native meanings.
 */
export interface LegacyGraphTaskTransitionInput {
  taskId: string;
  operationId: string;
  expectedVersion: TaskVersionRef;
  transition?: GraphTaskTransition;
  currentContext?: string;
  evidence?: string;
  worker: string;
}

type LegacyGraphTaskTransitionOutcome = Extract<TaskUpdatePortOutcome, {
  kind: "updated" | "refused" | "unknown_outcome" | "unavailable";
}>;
type Refusal = Extract<LegacyGraphTaskTransitionOutcome, { kind: "refused" }>;
type LegacyJournalInput = NonNullable<ModelToolTaskUpdateInput["journalEntries"]>;
type LegacyMutation = {
  transition: GraphTaskTransition | "context_updated";
  claim?: true;
  status?: TaskStatus;
  journalEntries?: LegacyJournalInput;
};

function refusal(
  input: LegacyGraphTaskTransitionInput,
  reason: Refusal["reason"],
  message: string,
  currentTask?: Refusal["currentTask"],
): Refusal {
  return {
    kind: "refused",
    taskId: input.taskId,
    operationId: input.operationId,
    reason,
    message,
    ...(currentTask ? { currentTask } : {}),
  };
}

function versionConflict(input: LegacyGraphTaskTransitionInput, currentTask: NonNullable<Refusal["currentTask"]>): Refusal {
  return refusal(
    input,
    "version_conflict",
    `Expected Task version ${input.expectedVersion}, but the current legacy Task version is ${currentTask.version}.`,
    currentTask,
  );
}

function unsupported(input: LegacyGraphTaskTransitionInput, currentTask: NonNullable<Refusal["currentTask"]>): Refusal | undefined {
  if (input.transition !== "goal_failed" && input.transition !== "cancel") return undefined;
  return refusal(
    input,
    "legacy_transition_unsupported",
    `Legacy Task authority cannot persist ${input.transition} without losing its distinct meaning. Apply a graph revision before this transition.`,
    currentTask,
  );
}

function mutation(input: LegacyGraphTaskTransitionInput): LegacyMutation | Refusal {
  if (!input.transition) {
    if (!input.currentContext?.trim()) {
      return refusal(input, "invalid_transition", "A Task command requires a transition or nonempty current context.");
    }
    return {
      transition: "context_updated",
      ...(input.evidence?.trim() ? { journalEntries: [{ kind: "note", text: input.evidence }] } : {}),
    };
  }

  if (["block", "goal_achieved", "goal_failed", "cancel"].includes(input.transition) && !input.evidence?.trim()) {
    return refusal(input, "evidence_required", `${input.transition} requires nonempty evidence.`);
  }

  switch (input.transition) {
    case "claim":
      // Beads claim persists Task metadata in the same native mutation, so a
      // context refresh keeps claim-specific blocker and owner checks.
      return { transition: "claim", claim: true };
    case "block":
      return {
        transition: "block",
        status: "blocked",
        journalEntries: [{ kind: "blocker", text: input.evidence! }],
      };
    case "resume":
      return { transition: "resume", status: "in_progress" };
    case "goal_achieved":
      return {
        transition: "goal_achieved",
        status: "closed",
        journalEntries: [{ kind: "result", text: input.evidence! }],
      };
    case "goal_failed":
    case "cancel":
      // The caller receives the explicit refusal after its exact version and
      // Worker ownership checks. Do not overload closed or blocked.
      return refusal(input, "legacy_transition_unsupported", "The legacy Task authority cannot represent this transition.");
    default:
      return refusal(input, "invalid_transition", `Unsupported Task transition ${String(input.transition)}.`);
  }
}

function stateRefusal(
  input: LegacyGraphTaskTransitionInput,
  currentTask: NonNullable<Refusal["currentTask"]>,
): Refusal | undefined {
  if (!input.transition) return undefined;
  if (input.transition === "claim") {
    if (currentTask.dependency_state?.kind === "waiting") {
      const blockers = currentTask.dependency_state.active_blocker_ids.join(", ");
      return refusal(
        input,
        "invalid_transition",
        `Task ${input.taskId} is dependency waiting for active blockers: ${blockers}. It is not blocked.`,
        currentTask,
      );
    }
    if (currentTask.status !== "open") {
      return refusal(input, "invalid_transition", `Task ${input.taskId} is ${currentTask.status}; claim requires open.`, currentTask);
    }
    return undefined;
  }
  if (input.transition === "block" || input.transition === "goal_achieved") {
    if (currentTask.status !== "in_progress") {
      return refusal(input, "invalid_transition", `Task ${input.taskId} is ${currentTask.status}; ${input.transition} requires in_progress.`, currentTask);
    }
    return undefined;
  }
  if (input.transition === "resume" && currentTask.status !== "blocked") {
    return refusal(input, "invalid_transition", `Task ${input.taskId} is ${currentTask.status}; resume requires blocked.`, currentTask);
  }
  return undefined;
}

function mapOutcome(
  input: LegacyGraphTaskTransitionInput,
  mapped: LegacyMutation,
  result: TaskUpdateOutcome,
): LegacyGraphTaskTransitionOutcome {
  if (result.kind === "updated") {
    return {
      kind: "updated",
      taskId: input.taskId,
      operationId: input.operationId,
      replayed: result.replayed ?? false,
      transition: mapped.transition,
      task: result.task,
      journalEntries: result.journalEntries,
      readyTaskIds: [],
      ...(result.deliveryWarnings?.length ? { deliveryWarnings: result.deliveryWarnings } : {}),
    };
  }
  if (result.kind === "refused") {
    if (result.reason === "active_blockers") {
      const blockers = result.blockerIds?.join(", ") || "unknown blockers";
      return refusal(
        input,
        "invalid_transition",
        `Task ${input.taskId} is dependency waiting for active blockers: ${blockers}. It is not blocked.`,
        result.currentTask,
      );
    }
    return refusal(input, result.reason, result.message, result.currentTask);
  }
  return {
    kind: "unavailable",
    taskId: input.taskId,
    operationId: input.operationId,
    reason: "task_authority_unavailable",
    message: result.message,
  };
}

function isNotFound(error: unknown): error is BeadsError {
  return error instanceof BeadsError && /not found|no issue found/i.test(error.message);
}

/**
 * Apply one graph-shaped transition through the legacy Task authority.
 *
 * The caller selects this only while no graph snapshot exists. The adapter
 * keeps Beads expected-version and durable operation-replay behavior intact.
 */
export async function transitionLegacyGraphTask(
  adapter: Pick<BeadsTaskAdapter, "read" | "claim" | "update">,
  input: LegacyGraphTaskTransitionInput,
): Promise<LegacyGraphTaskTransitionOutcome> {
  let current: NonNullable<Refusal["currentTask"]>;
  try {
    const read = await adapter.read(input.taskId);
    if (read.kind !== "found") {
      return {
        kind: "unavailable",
        taskId: input.taskId,
        operationId: input.operationId,
        reason: "task_authority_unavailable",
        message: read.message,
      };
    }
    current = read.task;
  } catch (error) {
    if (isNotFound(error)) return refusal(input, "task_not_found", error.message);
    return {
      kind: "unavailable",
      taskId: input.taskId,
      operationId: input.operationId,
      reason: "task_authority_unavailable",
      message: `Legacy Task authority could not read ${input.taskId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // A receipt can prove one exact operation, but it cannot transfer Task
  // authority to a different current Worker.
  if (current.assignee !== input.worker) {
    return refusal(
      input,
      "worker_mismatch",
      `Task ${input.taskId} is assigned to ${current.assignee ?? "no Worker"}, not ${input.worker}.`,
      current,
    );
  }

  const mapped = mutation(input);
  if (current.version !== input.expectedVersion) {
    // A supported mutation still enters Beads so its durable replay receipt can
    // win over the stale-version check. Unsupported commands have no receipt.
    if ("kind" in mapped || unsupported(input, current)) return versionConflict(input, current);
    try {
      const replay = mapped.claim
        ? await adapter.claim({
          taskId: input.taskId,
          operationId: input.operationId,
          expectedVersion: input.expectedVersion,
          ...(input.currentContext !== undefined ? { currentContext: input.currentContext } : {}),
        })
        : await adapter.update({
          taskId: input.taskId,
          operationId: input.operationId,
          expectedVersion: input.expectedVersion,
          ...(input.currentContext !== undefined ? { currentContext: input.currentContext } : {}),
          ...(mapped.journalEntries ? { journalEntries: mapped.journalEntries } : {}),
          ...(mapped.status ? { status: mapped.status } : {}),
        });
      return mapOutcome(input, mapped, replay);
    } catch (error) {
      return {
        kind: "unknown_outcome",
        taskId: input.taskId,
        operationId: input.operationId,
        message: `Legacy Task transition outcome is unknown after authority interaction: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if ("kind" in mapped) return { ...mapped, currentTask: current };
  const unsupportedTransition = unsupported(input, current);
  if (unsupportedTransition) return unsupportedTransition;
  const invalidState = stateRefusal(input, current);
  if (invalidState) return invalidState;

  try {
    const result = mapped.claim
      ? await adapter.claim({
        taskId: input.taskId,
        operationId: input.operationId,
        expectedVersion: input.expectedVersion,
        ...(input.currentContext !== undefined ? { currentContext: input.currentContext } : {}),
      })
      : await adapter.update({
        taskId: input.taskId,
        operationId: input.operationId,
        expectedVersion: input.expectedVersion,
        ...(input.currentContext !== undefined ? { currentContext: input.currentContext } : {}),
        ...(mapped.journalEntries ? { journalEntries: mapped.journalEntries } : {}),
        ...(mapped.status ? { status: mapped.status } : {}),
      });
    return mapOutcome(input, mapped, result);
  } catch (error) {
    return {
      kind: "unknown_outcome",
      taskId: input.taskId,
      operationId: input.operationId,
      message: `Legacy Task transition outcome is unknown after authority interaction: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
