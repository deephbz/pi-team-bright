import { describe, expect, it } from "vitest";
import {
  GraphControlRefusal,
  GraphTaskController,
  type GraphTaskController as Controller,
  type GraphTaskDefinitionInput,
} from "./graph-control";

const aliases = {
  default: "openai-codex/gpt-5.6-codex:medium",
  capable: "openai-codex/gpt-5.6-codex:max",
};

function graph(): GraphTaskDefinitionInput[] {
  return [
    { key: "plan", title: "Plan", goal: "Produce an accepted plan.", assignee: "planner" },
    { key: "implement", title: "Implement", goal: "Implement the accepted plan.", assignee: "builder", modelAlias: "capable", needs: ["plan"] },
    {
      key: "review",
      title: "Review",
      goal: "Accept the implementation only when criteria pass.",
      assignee: "reviewer",
      needs: ["implement"],
      onGoalFailed: { target: "implement", maxTraversals: 1 },
    },
    { key: "verify", title: "Verify", goal: "Verify the accepted result.", assignee: "verifier", needs: ["review"] },
  ];
}

function transition(
  authority: Controller,
  taskId: string,
  transition: "claim" | "goal_achieved" | "goal_failed" | "cancel",
  sequence: number,
  evidence?: string,
): void {
  const task = authority.readTask(taskId);
  authority.transition({
    taskId,
    operationId: `${taskId}-${transition}-${sequence}`,
    expectedVersion: task.version,
    transition,
    ...(transition !== "cancel" ? { worker: task.assignee } : {}),
    ...(evidence ? { evidence } : {}),
  });
}

function achieve(authority: Controller, taskId: string, sequence: number): void {
  transition(authority, taskId, "claim", sequence);
  transition(authority, taskId, "goal_achieved", sequence, `${taskId} criterion passed.`);
}

describe("graph-native control executable contract", () => {
  it("runs the Auto Compact repair loop without releasing verification on failed review", () => {
    const authority = new GraphTaskController(aliases);
    const applied = authority.applyGraph({ operationId: "graph-1", tasks: graph() });
    expect(applied.readyTaskIds).toEqual(["plan"]);

    achieve(authority, "plan", 1);
    achieve(authority, "implement", 1);
    const implementation = authority.readAttempts("implement")[0];
    expect(implementation).toMatchObject({ modelAlias: "capable", resolvedModel: aliases.capable });

    transition(authority, "review", "claim", 1);
    const failed = authority.transition({
      taskId: "review",
      operationId: "review-goal-failed-1",
      expectedVersion: authority.readTask("review").version,
      transition: "goal_failed",
      worker: "reviewer",
      evidence: "Criterion failed: retry-loss defect remains.",
    });
    expect(failed.failureTraversal).toEqual({ sourceTaskId: "review", targetTaskId: "implement", traversal: 1 });
    expect(authority.readTask("implement").state.kind).toBe("ready");
    expect(authority.readTask("review").state.kind).toBe("dependency_waiting");
    expect(authority.readTask("verify").state.kind).toBe("dependency_waiting");
    expect(authority.readAttempts("implement")[0]).toMatchObject({ state: "completed", current: false });
    expect(authority.readAttempts("review")).toEqual([
      expect.objectContaining({ outcome: "goal_failed", state: "completed", current: false }),
    ]);
    expect(() => authority.transition({
      taskId: "review",
      operationId: "illegal-claim-while-waiting",
      expectedVersion: authority.readTask("review").version,
      transition: "claim",
      worker: "reviewer",
    })).toThrowError(GraphControlRefusal);
    expect(() => authority.transition({
      taskId: "review",
      operationId: "illegal-block-while-waiting",
      expectedVersion: authority.readTask("review").version,
      transition: "block",
      worker: "reviewer",
      evidence: "This is dependency waiting, not an external blocker.",
    })).toThrowError(GraphControlRefusal);

    achieve(authority, "implement", 2);
    achieve(authority, "review", 2);
    expect(authority.readTask("verify").state.kind).toBe("ready");
    expect(authority.readAttempts("review")[1].inputAttemptIds.implement).toBe(authority.readTask("implement").acceptedAttemptId);
  });

  it("derives joins, bounded failure exhaustion, exact replay, recovery, and cancellation", () => {
    const authority = new GraphTaskController(aliases);
    const joinGraph: GraphTaskDefinitionInput[] = [
      { key: "left", title: "Left", goal: "Pass left.", assignee: "left-worker" },
      { key: "right", title: "Right", goal: "Pass right.", assignee: "right-worker" },
      { key: "join", title: "Join", goal: "Use both current results.", assignee: "join-worker", needs: ["left", "right"] },
      {
        key: "retry",
        title: "Retry",
        goal: "Pass within two Attempts.",
        assignee: "retry-worker",
        onGoalFailed: { target: "retry", maxTraversals: 1 },
      },
    ];
    authority.applyGraph({ operationId: "join-graph", tasks: joinGraph });
    const replay = authority.applyGraph({ operationId: "join-graph", tasks: joinGraph });
    expect(replay.replayed).toBe(true);

    achieve(authority, "left", 1);
    expect(authority.readTask("join").state.kind).toBe("dependency_waiting");
    achieve(authority, "right", 1);
    expect(authority.readTask("join").state.kind).toBe("ready");

    transition(authority, "retry", "claim", 1);
    transition(authority, "retry", "goal_failed", 1, "First criterion failure.");
    expect(authority.readTask("retry").state.kind).toBe("ready");
    transition(authority, "retry", "claim", 2);
    transition(authority, "retry", "goal_failed", 2, "Second criterion failure.");
    expect(authority.readTask("retry").state).toMatchObject({ kind: "goal_failed", reason: "failure_edge_exhausted", traversals: 1 });

    const recovered = GraphTaskController.recover(authority.snapshot(), aliases);
    expect(recovered.trace()).toEqual(authority.trace());
    transition(recovered, "join", "cancel", 1, "Operator stopped this branch.");
    expect(recovered.readTask("join").state).toEqual({ kind: "cancelled", reason: "Operator stopped this branch." });
    expect(recovered.trace().events.some(event => event.kind === "failure_edge_traversed" && event.sourceTaskId === "join")).toBe(false);
  });

  it("atomically revises the graph, preserves unchanged success, and rejects stale completion", () => {
    const authority = new GraphTaskController(aliases);
    authority.applyGraph({ operationId: "revision-1", tasks: graph() });
    achieve(authority, "plan", 1);
    const planAttempt = authority.readTask("plan").acceptedAttemptId;
    transition(authority, "implement", "claim", 1);
    const staleImplementationVersion = authority.readTask("implement").version;

    const revised = graph().map(task => task.key === "implement"
      ? { ...task, goal: "Implement the accepted plan and preserve retry state." }
      : task);
    authority.applyGraph({
      operationId: "revision-2",
      expectedGraphVersion: authority.currentGraphVersion(),
      tasks: revised,
    });
    expect(authority.readTask("plan")).toMatchObject({ state: { kind: "goal_achieved" }, acceptedAttemptId: planAttempt });
    expect(authority.readTask("implement").state.kind).toBe("ready");
    expect(authority.readAttempts("implement")[0].state).toBe("superseded");
    expect(authority.readAttempts("plan")[0]).toMatchObject({ state: "completed", current: true });
    expect(() => authority.transition({
      taskId: "implement",
      operationId: "late-completion",
      expectedVersion: staleImplementationVersion,
      transition: "goal_achieved",
      worker: "builder",
      evidence: "Late result from the prior definition.",
    })).toThrowError(GraphControlRefusal);

    const snapshotBeforeRefusal = authority.snapshot();
    expect(() => authority.applyGraph({
      operationId: "bad-revision",
      expectedGraphVersion: authority.currentGraphVersion(),
      tasks: [{ key: "cycle", title: "Cycle", goal: "Reject a success cycle.", assignee: "builder", needs: ["cycle"] }],
    })).toThrowError(GraphControlRefusal);
    expect(authority.snapshot()).toEqual(snapshotBeforeRefusal);

    expect(() => authority.transition({
      taskId: "implement",
      operationId: "operation-reuse-conflict",
      expectedVersion: authority.readTask("implement").version,
      transition: "claim",
      worker: "builder",
    })).not.toThrow();
    expect(() => authority.transition({
      taskId: "implement",
      operationId: "operation-reuse-conflict",
      expectedVersion: authority.readTask("implement").version,
      transition: "goal_achieved",
      worker: "builder",
      evidence: "Changed semantics under one operation identity.",
    })).toThrowError(GraphControlRefusal);
  });
});
