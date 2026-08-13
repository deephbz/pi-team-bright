import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { TaskUpdateParametersSchema, TaskUpdateResultSchema } from "./catalog";
import { projectToolResult } from "./result-projection";
import { taskVersionRef } from "./task-version-ref";

describe("Task update version refs", () => {
  it("accepts graph transitions or context changes and projects opaque refs", () => {
    const v1 = taskVersionRef("task_v1");
    for (const update of [
      { task_id: "task-1", operation_id: "claim", expected_version: v1, transition: "claim" },
      { task_id: "task-1", operation_id: "context", expected_version: v1, current_context: "Meaning changed." },
      { task_id: "task-1", operation_id: "fail", expected_version: v1, transition: "goal_failed", evidence: "Criterion did not pass." },
    ]) expect(Check(TaskUpdateParametersSchema, update)).toBe(true);
    expect(Check(TaskUpdateParametersSchema, { task_id: "task-1", operation_id: "none", expected_version: v1 })).toBe(false);
    expect(Check(TaskUpdateParametersSchema, { task_id: "task-1", operation_id: "raw", expected_version: "task_v1", transition: "claim" })).toBe(false);
    expect(Check(TaskUpdateParametersSchema, { task_id: "task-1", operation_id: "derived", expected_version: v1, transition: "ready" })).toBe(false);

    const raw = {
      kind: "updated" as const,
      input_index: 0,
      task_id: "task-1",
      operation_id: "claim",
      replayed: false,
      transition: "claim" as const,
      task: {
        id: "task-1",
        title: "Verify",
        goal: "Verify opaque refs.",
        assignee: "verifier",
        model: "default" as const,
        needs: [],
        status: "in_progress" as const,
        state: { kind: "in_progress" as const, attempt_id: "task-1@1" },
        current_context: "Work has not started.",
        version: taskVersionRef("task_v2"),
        activation_key: "activation-task-1",
        current_attempt: { id: "task-1@1", ordinal: 1, resolved_model: "default-model", input_attempt_ids: {} },
        attempts_started: 1,
      },
      ready_task_ids: [],
    };
    expect(Check(TaskUpdateResultSchema, raw)).toBe(true);
    const model = projectToolResult("task_update", raw) as { kind: string; task: { version: string } };
    expect(model.task.version).toMatch(/^v_[0-9a-f]{16}$/);
    expect(model.task.version).not.toBe("task_v2");
  });
});
