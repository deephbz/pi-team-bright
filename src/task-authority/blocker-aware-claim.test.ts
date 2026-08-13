import { describe, expect, it, vi } from "vitest";
import { BeadsTaskAdapter, type TaskAdapterAuthority } from "../model-tool-contract/beads-task-adapter";
import { TASK_METADATA_SCHEMA, type TaskAuthorityRecordEnvelope } from "../utils/beads";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";

function record(): TaskAuthorityRecordEnvelope {
  return {
    task: {
      id: "impl-1",
      title: "Implement",
      description: "Implement.",
      acceptanceCriteria: "Implement.",
      status: "open",
      assignee: "maker",
      relations: [{ relation: "blocked_by", targetId: "plan-1" }],
      activeBlockerIds: ["plan-1"],
      version: "beads_impl_v1",
      provenance: { authority: "beads", teamName: "release-team" },
    },
    taskMetadata: { schema: TASK_METADATA_SCHEMA, goal: "Implement.", current_context: "Work has not started." },
  };
}

describe("blocker-aware Worker claim", () => {
  it("refuses before native claim and returns exact active blocker IDs", async () => {
    const update = vi.fn();
    const authority: TaskAdapterAuthority = {
      mode: "publishing",
      create: vi.fn() as any,
      read: async () => record(),
      readMany: async () => [record()],
      list: async () => ["impl-1"],
      update,
      link: vi.fn() as any,
    };
    const adapter = new BeadsTaskAdapter("release-team", "maker", authority);
    const result = await adapter.claim({
      taskId: "impl-1",
      operationId: "claim-impl-1",
      expectedVersion: taskVersionRef("beads_impl_v1"),
    });
    expect(result).toMatchObject({
      kind: "refused",
      reason: "active_blockers",
      blockerIds: ["plan-1"],
    });
    expect(update).not.toHaveBeenCalled();
  });
});
