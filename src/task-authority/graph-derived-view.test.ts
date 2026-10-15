import { expect, it, vi } from "vitest";
import { GraphTaskController } from "./graph-control";

function fixture() {
  const controller = new GraphTaskController();
  controller.applyGraph({ operationId: "initial", tasks: [{ key: "task", title: "Task", goal: "Complete work", assignee: "worker", needs: [] }] });
  return controller;
}
it("derives each unchanged controller state once and keeps caller mutations isolated", () => {
  const controller = fixture();
  const compute = vi.spyOn(controller as any, "derive");
  const recovered = GraphTaskController.recover(controller.snapshot());
  const recoveredCompute = vi.spyOn(recovered as any, "derive");
  const tasks = recovered.readTasks();
  tasks[0]!.needs.push("invented");
  recovered.readAttempts();
  recovered.selectReadyFrontier();
  recovered.trace();
  expect(recovered.readTask("task").needs).toEqual([]);
  expect(recoveredCompute).toHaveBeenCalledTimes(1);
  const task = controller.readTask("task");
  controller.transition({ operationId: "claim", taskId: "task", worker: "worker", expectedVersion: task.version, transition: "claim" });
  expect(controller.readTask("task").state.kind).toBe("in_progress");
  expect(compute).toHaveBeenCalledTimes(1);
  compute.mockRestore(); recoveredCompute.mockRestore();
});
it("does not reuse speculative state after command rollback", () => {
  const controller = fixture();
  const before = controller.readTask("task");
  const original = (controller as any).toView;
  // Throw after claim has appended its event and derived the new state.
  const projection = vi.spyOn(controller as any, "toView").mockImplementation(function(this: unknown, task: any) {
    if (task.state.kind === "in_progress") throw new Error("injected projection failure");
    return original.call(this, task);
  });
  expect(() => controller.transition({ operationId: "failed-claim", taskId: "task", worker: "worker", expectedVersion: before.version, transition: "claim" })).toThrow("injected");
  projection.mockRestore();
  expect(controller.readTask("task")).toEqual(before);
  expect(controller.readAttempts()).toEqual([]);
  const result = controller.transition({ operationId: "retry", taskId: "task", worker: "worker", expectedVersion: before.version, transition: "claim" });
  expect(result.task.state.kind).toBe("in_progress");
});
