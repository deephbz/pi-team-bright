import { afterEach, describe, expect, it, vi } from "vitest";
import * as authority from "../model-tool-contract/beads-authority-adapter";
import * as taskAdapter from "../model-tool-contract/beads-task-adapter";
import { BeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import type { TaskCard } from "../model-tool-contract/task-domain";
import { BeadsTaskReconciliationQuery } from "./beads-reconciliation-query";

function task(id: string): TaskCard {
  return {
    id,
    title: id,
    goal: `Read ${id} through the Task authority.`,
    current_context: `Current context for ${id}.`,
    status: "open",
    assignee: "worker",
    version: taskVersionRef(`reconciliation-${id}`),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("BeadsTaskReconciliationQuery", () => {
  it("keeps authority list order and exact canonical card outcomes for delivery recovery", async () => {
    const teamName = "reconciliation-query-team";
    const first = task("task-first");
    const second = task("task-second");
    const list = vi.spyOn(authority, "listTaskIds").mockResolvedValue([first.id, second.id]);
    const readMany = vi.spyOn(BeadsTaskAdapter.prototype, "readMany").mockResolvedValue([
      { kind: "found", task: first },
      {
        kind: "contract_gap",
        reason: "task_metadata_invalid",
        taskId: second.id,
        version: "v_0123456789abcdef",
        message: "Task metadata is invalid.",
      },
    ]);

    await expect(new BeadsTaskReconciliationQuery(teamName).readCurrentTasks()).resolves.toEqual([
      { kind: "found", task: first },
      {
        kind: "contract_gap",
        reason: "task_metadata_invalid",
        taskId: second.id,
        version: "v_0123456789abcdef",
        message: "Task metadata is invalid.",
      },
    ]);
    expect(list).toHaveBeenCalledWith(teamName);
    expect(readMany).toHaveBeenCalledWith([first.id, second.id]);
  });

  it("uses the same Team-scoped raw owner-transition evidence reader without translating failures", async () => {
    const evidence = { task: task("task-owner"), operationId: "owner-transition-operation" };
    const read = vi.spyOn(taskAdapter, "readTaskOwnerTransitionEvidence").mockResolvedValue(evidence);

    await expect(new BeadsTaskReconciliationQuery("owner-evidence-team").readOwnerTransitionEvidence("task-owner"))
      .resolves.toBe(evidence);
    expect(read).toHaveBeenCalledWith("owner-evidence-team", "task-owner");

    const failure = new Error("configured Task authority fingerprint no longer matches");
    read.mockRejectedValueOnce(failure);
    await expect(new BeadsTaskReconciliationQuery("owner-evidence-team").readOwnerTransitionEvidence("task-owner"))
      .rejects.toBe(failure);
  });
});
