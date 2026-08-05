import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { TaskUpdateParametersSchema } from "./catalog";
import { InMemoryModelToolTeamPort, exactLeaderSessionId } from "./in-memory-team-port";
import { projectToolResult } from "./result-projection";
import { taskVersionRef } from "./task-version-ref";

describe("Task update version refs", () => {
  it("accepts one supplied change, preserves omitted context, and projects opaque refs", async () => {
    const v1 = taskVersionRef("task_v1");
    for (const update of [
      { task_id: "task-1", operation_id: "status", expected_version: v1, status: "in_progress" },
      { task_id: "task-1", operation_id: "context", expected_version: v1, current_context: "Meaning changed." },
      { task_id: "task-1", operation_id: "journal", expected_version: v1, journal_entries: [{ kind: "progress", text: "Work started." }] },
    ]) expect(Check(TaskUpdateParametersSchema, { updates: [update] })).toBe(true);
    expect(Check(TaskUpdateParametersSchema, { updates: [{ task_id: "task-1", operation_id: "none", expected_version: v1 }] })).toBe(false);
    expect(Check(TaskUpdateParametersSchema, { updates: [{ task_id: "task-1", operation_id: "raw", expected_version: "task_v1", status: "open" }] })).toBe(false);

    const port = new InMemoryModelToolTeamPort();
    const session = exactLeaderSessionId("leader-session");
    await port.createTeam(session, { name: "release", purpose: "Verify refs." });
    await port.createTask(session, { operationId: "create-verify", title: "Verify", goal: "Verify opaque refs." });
    const updated = await port.updateTasks(session, [{ taskId: "task-1", operationId: "status", expectedVersion: v1, status: "in_progress" }]);
    expect(updated).toMatchObject({ kind: "batch", outcomes: [{ kind: "updated", task: { current_context: "Work has not started.", version: taskVersionRef(v1) } }] });

    if (updated.kind !== "batch" || updated.outcomes[0]?.kind !== "updated") throw new Error("Expected updated Task outcome.");
    const raw = { kind: "task_update_batch" as const, outcomes: [{
      kind: "updated" as const,
      input_index: 0,
      task_id: "task-1",
      operation_id: "status",
      task: updated.outcomes[0].task,
      journal_entries: [],
    }] };
    const model = projectToolResult("task_update", raw) as { kind: string; task: { version: string } };
    expect(model.task.version).toMatch(/^v_[0-9a-f]{16}$/);
    expect(model.task.version).not.toBe("task_v2");
  });
});
