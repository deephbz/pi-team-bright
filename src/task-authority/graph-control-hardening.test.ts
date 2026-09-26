import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { teamDir } from "../utils/paths";
import type { TaskVersionRef } from "./task-version-ref";
import { GraphControlRefusal, GraphTaskController } from "./graph-control";

function achieve(controller: GraphTaskController, taskId: string): void {
  let task = controller.readTask(taskId);
  controller.transition({ taskId, operationId: `${taskId}-claim`, expectedVersion: task.version, transition: "claim", worker: task.assignee });
  task = controller.readTask(taskId);
  controller.transition({ taskId, operationId: `${taskId}-pass`, expectedVersion: task.version, transition: "goal_achieved", worker: task.assignee, evidence: "Criterion passed." });
}

describe("graph control adversarial regressions", () => {
  it("records an accepted prerequisite whose valid key is __proto__", () => {
    const controller = new GraphTaskController();
    controller.applyGraph({ operationId: "apply", tasks: [
      { key: "__proto__", title: "Input", goal: "Pass.", assignee: "worker-a" },
      { key: "consumer", title: "Consumer", goal: "Use input.", assignee: "worker-b", needs: ["__proto__"] },
    ] });
    achieve(controller, "__proto__");
    const expected = controller.readTask("__proto__").acceptedAttemptId;
    const consumer = controller.readTask("consumer");
    expect(consumer.state.kind).toBe("ready");
    controller.transition({ taskId: "consumer", operationId: "consumer-claim", expectedVersion: consumer.version, transition: "claim", worker: "worker-b" });
    const inputs = controller.readAttempts("consumer")[0].inputAttemptIds;
    expect(Object.hasOwn(inputs, "__proto__")).toBe(true);
    expect(inputs["__proto__"]).toBe(expected);
  });

  it("refuses a snapshot with an event for a missing Attempt", () => {
    const controller = new GraphTaskController();
    controller.applyGraph({ operationId: "apply", tasks: [{ key: "task", title: "Task", goal: "Pass.", assignee: "worker" }] });
    const task = controller.readTask("task");
    controller.transition({ taskId: "task", operationId: "claim", expectedVersion: task.version, transition: "claim", worker: "worker" });
    controller.transition({ taskId: "task", operationId: "block", expectedVersion: controller.readTask("task").version, transition: "block", worker: "worker", evidence: "External wait." });
    const snapshot = controller.snapshot();
    const block = snapshot.events.find((event) => event.kind === "attempt_blocked");
    if (!block) throw new Error("Expected Attempt block.");
    block.attemptId = "missing-start";
    expect(() => GraphTaskController.recover(snapshot)).toThrowError(GraphControlRefusal);
  });

  it("refuses use of a forged replay receipt instead of returning false ready work", () => {
    const controller = new GraphTaskController();
    controller.applyGraph({ operationId: "apply", tasks: [{ key: "task", title: "Task", goal: "Pass.", assignee: "worker" }] });
    const snapshot = controller.snapshot();
    const receipt = snapshot.receipts[0];
    if (receipt.result.kind !== "graph_applied") throw new Error("Expected graph receipt.");
    receipt.result.readyTaskIds = ["forged"];
    const recovered = GraphTaskController.recover(snapshot);
    expect(() => recovered.applyGraph({ operationId: "apply", tasks: [{ key: "task", title: "Task", goal: "Pass.", assignee: "worker" }] }))
      .toThrowError(GraphControlRefusal);
  });

  it("refuses a stored failure traversal beyond the graph budget", () => {
    const controller = new GraphTaskController();
    const tasks = [{ key: "task", title: "Task", goal: "Pass.", assignee: "worker", onGoalFailed: { target: "task", maxTraversals: 1 } }];
    controller.applyGraph({ operationId: "apply", tasks });
    let task = controller.readTask("task");
    controller.transition({ taskId: "task", operationId: "claim", expectedVersion: task.version, transition: "claim", worker: "worker" });
    task = controller.readTask("task");
    controller.transition({ taskId: "task", operationId: "fail", expectedVersion: task.version, transition: "goal_failed", worker: "worker", evidence: "Criterion failed." });
    const snapshot = controller.snapshot();
    const traversal = snapshot.events.find((event) => event.kind === "failure_edge_traversed");
    if (!traversal) throw new Error("Expected traversal.");
    traversal.traversal = 9;
    expect(() => GraphTaskController.recover(snapshot)).toThrowError(GraphControlRefusal);
  });

  it("returns the original operation delta when replay follows a later graph revision", async () => {
    const teamName = `graph-operation-boundary-${process.pid}-${Date.now()}`;
    try {
      const authority = new DurableGraphTaskAuthority();
      const firstInput = { operationId: "apply-first", tasks: [{ key: "task", title: "Task", goal: "Original goal.", assignee: "worker" }] };
      const first = await authority.applyGraph(teamName, firstInput);
      await authority.applyGraph(teamName, {
        operationId: "apply-second",
        expectedGraphVersion: first.result.graphVersion,
        tasks: [{ key: "task", title: "Task", goal: "Revised goal.", assignee: "worker" }],
      });
      const replay = await authority.applyGraph(teamName, firstInput);
      expect(replay.result.replayed).toBe(true);
      expect(replay.operationBefore).toEqual([]);
      expect(replay.operationAfter[0].goal).toBe("Original goal.");
      expect(replay.after[0].goal).toBe("Revised goal.");
      expect(replay.operationGraphVersion).toBe(first.result.graphVersion);
      expect(replay.operationAuthoritySequence).toBe(first.operationAuthoritySequence);

      const currentTask = (await authority.readTasks(teamName))[0];
      const claim = { taskId: "task", operationId: "claim", expectedVersion: currentTask.version as TaskVersionRef, transition: "claim" as const, worker: "worker" };
      await authority.transition(teamName, claim);
      const activeTask = (await authority.readTasks(teamName))[0];
      await authority.transition(teamName, {
        taskId: "task", operationId: "block", expectedVersion: activeTask.version as TaskVersionRef,
        transition: "block", worker: "worker", evidence: "External wait.",
      });
      const claimReplay = await authority.transition(teamName, claim);
      expect(claimReplay.operationBefore[0].status).toBe("ready");
      expect(claimReplay.operationAfter[0].status).toBe("in_progress");
      expect(claimReplay.after[0].status).toBe("blocked");
    } finally {
      fs.rmSync(teamDir(teamName), { recursive: true, force: true });
    }
  });
});
