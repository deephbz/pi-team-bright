import { describe, expect, it, vi } from "vitest";
import type { TaskCard } from "../model-tool-contract/task-domain";
import { reconcileReadyTaskDeliveries, type TaskReadyDeliveryPort } from "./ready-dispatch";

function card(id: string, assignee: string, status: TaskCard["status"] = "open", blockers: string[] = []): TaskCard {
  return {
    id,
    title: id,
    goal: `Complete ${id}.`,
    status,
    assignee,
    relations: blockers.map((target_task_id) => ({ relation: "blocked_by" as const, target_task_id })),
    dependency_state: blockers.length
      ? { kind: "waiting", active_blocker_ids: blockers }
      : { kind: "ready", active_blocker_ids: [] },
    current_context: "Ready.",
    version: `v_${id.padEnd(16, "0").slice(0, 16)}`,
  };
}

describe("Task-owned ready dispatch", () => {
  it("selects one stable ready Task per free Worker and persists through the port", async () => {
    const tasks = [
      card("a", "maker"),
      card("b", "maker"),
      card("c", "reviewer", "open", ["a"]),
      card("d", "reviewer"),
    ];
    const enqueueReadyTask = vi.fn(async (_team: string, _task: TaskCard, _worker: string) => true);
    const port: TaskReadyDeliveryPort = {
      readDeliveryCoordinates: vi.fn(async () => []),
      enqueueReadyTask,
    };

    await expect(reconcileReadyTaskDeliveries("dag-team", {
      readDispatchSnapshot: async () => ({ readyTasks: [tasks[0], tasks[1], tasks[3]], occupiedWorkers: [] }),
    }, port)).resolves.toEqual([]);
    expect(enqueueReadyTask.mock.calls.map((call) => [call[1].id, call[2]])).toEqual([
      ["a", "maker"],
      ["d", "reviewer"],
    ]);
  });

  it("keeps a Worker occupied by an exact active delivery and reports port failures", async () => {
    const tasks = [card("a", "maker"), card("b", "maker"), card("c", "reviewer")];
    const enqueueReadyTask = vi.fn(async (_team: string, task: TaskCard, _worker: string) => {
      if (task.id === "c") throw new Error("spool unavailable");
      return true;
    });
    const port: TaskReadyDeliveryPort = {
      readDeliveryCoordinates: vi.fn(async (_team, worker) => worker === "maker" ? [{
        taskId: "a",
        taskVersion: tasks[0].version,
        worker,
        state: "presented" as const,
      }] : []),
      enqueueReadyTask,
    };

    await expect(reconcileReadyTaskDeliveries("dag-team", {
      readDispatchSnapshot: async () => ({ readyTasks: tasks, occupiedWorkers: [] }),
    }, port)).resolves.toEqual([
      "Task c committed but delivery enqueue for reviewer failed: spool unavailable",
    ]);
    expect(enqueueReadyTask).toHaveBeenCalledTimes(1);
    expect(enqueueReadyTask.mock.calls[0][1].id).toBe("c");
  });
});
