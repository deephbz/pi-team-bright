import { describe, expect, it, vi } from "vitest";
import { Check } from "typebox/value";
import {
  ModelResultSchemas,
  assembleToolResult,
  projectToolResult,
} from "./result-projection";
import { projectTui } from "./tui-projection";
import { InMemoryModelToolTeamPort, exactLeaderSessionId, type ModelToolTeamPort } from "./in-memory-team-port";
import { registerModelToolJourney, type ModelToolRegistration } from "./pi-registration";
import { BeadsTaskAdapter, type TaskAdapterAuthority } from "./beads-task-adapter";
import type { TaskAuthorityRecord } from "../utils/beads";
import { taskVersionRef } from "./task-version-ref";

const task = {
  id: "task-1", title: "Verify", goal: "Verify the release.", status: "open" as const,
  relations: [], dependency_state: { kind: "ready" as const, active_blocker_ids: [] },
  current_context: "Work has not started.", version: taskVersionRef("beads_task_1"),
};
const session = exactLeaderSessionId("totality-session");

function assertTotal(tool: "task_create" | "task_update", raw: any) {
  const assembly = assembleToolResult(tool, raw);
  const model = projectToolResult(tool, raw);
  expect(Check(ModelResultSchemas[tool], model)).toBe(true);
  expect(assembly.content[0].text).toBe(JSON.stringify(model));
  const tui = projectTui({ tool, details: raw, expanded: true }).join("\n");
  expect(tui).not.toContain("did not produce a semantic result");
  expect(tui).not.toContain("semantic details could not be validated");
}

function registered(port: ModelToolTeamPort) {
  const tools = new Map<string, ModelToolRegistration>();
  registerModelToolJourney({ registerTool: (tool) => tools.set(tool.name, tool) }, port);
  const context = { sessionManager: { getSessionId: () => session } };
  return async (name: "task_create" | "task_update", params: any) => {
    const tool = tools.get(name)!;
    expect(Check(tool.parameters as any, params)).toBe(true);
    return tool.execute("totality-call", params, new AbortController().signal, undefined, context);
  };
}

describe("task semantic-result totality", () => {
  it("projects every declared task_create and task_update raw outcome without generic TUI failure", () => {
    const create = [
      { kind: "task_graph_created", operation_id: "create-ok", replayed: false, tasks_by_key: { verify: task }, ready_task_ids: [task.id] },
      { kind: "refused", operation_id: "create-conflict", reason: "worker_unavailable", message: "Worker is absent.", state_changed: false },
      { kind: "refused", operation_id: "create-replay", reason: "operation_conflict", message: "Operation differs.", state_changed: false },
      { kind: "unavailable", operation_id: "create-down", reason: "task_authority_unavailable", message: "Authority is unavailable.", state_changed: false },
      { kind: "unknown_outcome", operation_id: "create-unknown", message: "Authority response was lost." },
    ];
    for (const outcome of create) assertTotal("task_create", outcome);

    const update = [
      { kind: "updated", input_index: 0, task_id: task.id, operation_id: "update-ok", task, journal_entries: [] },
      ...["task_not_found", "version_conflict", "operation_conflict", "terminal_evidence_required"].map((reason) => ({ kind: "refused", input_index: 0, task_id: task.id, operation_id: `update-${reason}`, reason, message: `${reason}.`, current_task: task, state_changed: false })),
      { kind: "contract_gap", input_index: 0, task_id: task.id, operation_id: "update-gap", reason: "task_metadata_invalid", message: "Metadata is invalid.", unsupported: ["task_metadata"], current_task: task, state_changed: false },
      { kind: "unavailable", input_index: 0, task_id: task.id, operation_id: "update-down", reason: "task_authority_unavailable", message: "Authority is unavailable.", state_changed: false },
    ];
    for (const outcome of update) assertTotal("task_update", { kind: "task_update_batch", outcomes: [outcome] });
  });

  it("labels a post-create authority exception as an unknown outcome with its same-operation coordinate", async () => {
    type PublishingAuthority = Extract<TaskAdapterAuthority, { mode: "publishing" }>;
    const authorityTask: TaskAuthorityRecord = {
      id: "task-1",
      title: "Verify",
      description: "Verify the release.",
      acceptanceCriteria: "",
      status: "open",
      relations: [],
      version: "beads_task_1",
      provenance: { authority: "beads", teamName: "totality-team" },
    };
    const read = vi.fn<PublishingAuthority["read"]>().mockRejectedValue(new Error("post-create authority read failed"));
    const authority: PublishingAuthority = {
      mode: "publishing",
      read,
      readMany: vi.fn<PublishingAuthority["readMany"]>(),
      list: vi.fn<PublishingAuthority["list"]>(),
      create: vi.fn<PublishingAuthority["create"]>().mockResolvedValue({
        task: authorityTask,
        changed: true,
        appliedOperations: [],
        deliveryDegraded: false,
        deliveryWarnings: [],
        publication: {
          teamEvent: { appended: true },
          delivery: {
            attemptedRecipients: [],
            failedRecipients: [],
            recoveryRecordedFor: [],
            recoveryRecordFailedFor: [],
          },
        },
      }),
      update: vi.fn<PublishingAuthority["update"]>(),
      link: vi.fn<PublishingAuthority["link"]>(),
    };
    const adapter = new BeadsTaskAdapter("totality-team", "team-lead", authority);
    await expect(adapter.create({ operationId: "create-unknown", title: "Verify", goal: "Verify the release." })).resolves.toMatchObject({
      kind: "unknown_outcome",
      operationId: "create-unknown",
      message: expect.stringContaining("outcome is unknown"),
    });
    expect(authority.create).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith("task-1");
  });

  it("keeps every expected port outcome semantic through Pi registration", async () => {
    const port = new InMemoryModelToolTeamPort();
    const invoke = registered(port);
    const create = vi.spyOn(port, "createTaskGraph");
    const update = vi.spyOn(port, "updateTasks");

    for (const outcome of [
      { kind: "created", operationId: "create-ok", replayed: false, tasksByKey: { verify: task }, readyTaskIds: [task.id] },
      { kind: "refused", operationId: "create-worker", reason: "worker_unavailable", message: "Worker is absent." },
      { kind: "refused", operationId: "create-conflict", reason: "operation_conflict", message: "Operation differs." },
      { kind: "unknown_outcome", operationId: "create-unknown", message: "Outcome is unknown." },
      { kind: "unavailable", operationId: "create-down", reason: "task_authority_unavailable", message: "Authority is unavailable." },
      { kind: "no_active_team", operationId: "create-unbound" },
    ]) {
      create.mockResolvedValueOnce(outcome as any);
      const result = await invoke("task_create", { operation_id: outcome.operationId, tasks: [{ key: "verify", title: "Verify", goal: "Verify the release.", assignee: "verifier" }] });
      assertTotal("task_create", result.details);
      if (outcome.kind === "unknown_outcome") {
        expect(JSON.parse(result.content[0].text)).toMatchObject({ recovery: { action: "retry_same_operation", operation_id: outcome.operationId } });
      }
    }

    for (const outcome of [
      { kind: "updated", taskId: task.id, operationId: "update-ok", task, journalEntries: [] },
      ...["task_not_found", "version_conflict", "operation_conflict", "terminal_evidence_required"].map((reason) => ({ kind: "refused", taskId: task.id, operationId: `update-${reason}`, reason, message: `${reason}.`, currentTask: task })),
      { kind: "contract_gap", taskId: task.id, operationId: "update-gap", reason: "task_metadata_invalid", message: "Metadata is invalid.", currentTask: task, unsupported: ["task_metadata"] },
      { kind: "unavailable", taskId: task.id, operationId: "update-down", reason: "task_authority_unavailable", message: "Authority is unavailable." },
    ]) {
      update.mockResolvedValueOnce({ kind: "batch", outcomes: [outcome] } as any);
      const result = await invoke("task_update", { updates: [{ task_id: task.id, operation_id: outcome.operationId, expected_version: "v_0123456789abcdef", current_context: "Work has not started." }] });
      assertTotal("task_update", result.details);
    }
  });
});
