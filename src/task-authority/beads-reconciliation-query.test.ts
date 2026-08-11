import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadOnlyBeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";
import { TASK_METADATA_KEY, TASK_METADATA_SCHEMA, type TaskAuthorityRecordEnvelope, type TaskMetadata } from "../utils/beads";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import type { TaskCard } from "../model-tool-contract/task-domain";
import { BeadsTaskReconciliationQuery } from "./beads-reconciliation-query";

function metadata(goal: string, currentContext: string): TaskMetadata {
  return { schema: TASK_METADATA_SCHEMA, goal, current_context: currentContext };
}

function task(id: string): TaskCard & { goal: string } {
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
    const records: Array<TaskAuthorityRecordEnvelope | undefined> = [
      { task: { id: first.id, title: first.title, description: "Compatibility", acceptanceCriteria: "Compatibility", status: "open", relations: [], version: "raw-first", provenance: { authority: "beads", teamName } }, taskMetadata: metadata(first.goal, first.current_context) },
      { task: { id: second.id, title: second.title, description: "Compatibility", acceptanceCriteria: "Compatibility", status: "open", relations: [], version: "raw-second", provenance: { authority: "beads", teamName } }, taskMetadata: { schema: "wrong" } },
    ];
    const readPort = {
      listTaskIds: vi.fn(async () => [first.id, second.id]),
      readTaskAuthorityRecordEnvelope: vi.fn(),
      readTaskAuthorityRecordEnvelopes: vi.fn(async () => records),
    };
    const query = new BeadsTaskReconciliationQuery(teamName, createReadOnlyBeadsTaskAdapterFactory(readPort));

    await expect(query.readCurrentTasks()).resolves.toEqual([
      { kind: "found", task: { id: first.id, title: first.title, goal: first.goal, current_context: first.current_context, status: first.status, version: taskVersionRef("raw-first") } },
      { kind: "contract_gap", reason: "task_metadata_invalid", taskId: second.id, version: taskVersionRef("raw-second"), message: `Task ${second.id} has unsupported or incomplete canonical ${TASK_METADATA_KEY} metadata.` },
    ]);
    expect(readPort.listTaskIds).toHaveBeenCalledWith(teamName);
    expect(readPort.readTaskAuthorityRecordEnvelopes).toHaveBeenCalledWith(teamName, [first.id, second.id]);
  });

  it("uses the injected Team-scoped owner-transition evidence reader without translating failures", async () => {
    const owner = task("task-owner");
    const evidence = { task: { id: owner.id, title: owner.title, goal: owner.goal, current_context: owner.current_context, status: owner.status, version: taskVersionRef("raw-owner") }, operationId: "owner-transition-operation" };
    const envelope: TaskAuthorityRecordEnvelope = {
      task: { id: evidence.task.id, title: evidence.task.title, description: "Compatibility", acceptanceCriteria: "Compatibility", status: "open", relations: [], version: "raw-owner", provenance: { authority: "beads", teamName: "owner-evidence-team" } },
      taskMetadata: metadata(evidence.task.goal, evidence.task.current_context),
      ownerTransitionOperationId: evidence.operationId,
    };
    const read = vi.fn(async () => envelope);
    const factory = createReadOnlyBeadsTaskAdapterFactory({
      listTaskIds: vi.fn(), readTaskAuthorityRecordEnvelopes: vi.fn(), readTaskAuthorityRecordEnvelope: read,
    });
    const query = new BeadsTaskReconciliationQuery("owner-evidence-team", factory);

    await expect(query.readOwnerTransitionEvidence("task-owner")).resolves.toEqual(evidence);
    expect(read).toHaveBeenCalledWith("owner-evidence-team", "task-owner");

    const failure = new Error("configured Task authority fingerprint no longer matches");
    read.mockRejectedValueOnce(failure);
    await expect(query.readOwnerTransitionEvidence("task-owner")).rejects.toBe(failure);
  });
});
