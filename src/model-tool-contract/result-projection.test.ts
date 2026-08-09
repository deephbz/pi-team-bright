import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  AlertSendParametersSchema,
  TaskCreateResultSchema,
  TaskReadResultSchema,
  TaskUpdateResultSchema,
  modelToolCatalog,
} from "./catalog";
import {
  ModelResultSchemas,
  assembleToolResult,
  parseToolResult,
  projectToolResult,
  serializeToolResult,
} from "./result-projection";
import { projectTui } from "./tui-projection";
import { taskVersionRef } from "./task-version-ref";

function captureError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected action to throw.");
}

describe("raw semantic result projections", () => {
  it("assembles the same valid projection and preserves raw detail identity", () => {
    const raw = {
      kind: "team_created" as const,
      team: { name: "review", purpose: "Review the release.", lifecycle: "active" as const },
    };
    const projected = projectToolResult("team_create", raw);
    const assembled = assembleToolResult("team_create", raw);

    expect(assembled.content).toEqual([{ type: "text", text: JSON.stringify(projected) }]);
    expect(assembled.details).toBe(raw);
  });

  it("keeps assembly and projection semantic-schema errors identical", () => {
    const invalid = {
      kind: "team_created",
      team: { name: "review", lifecycle: "active" },
    } as any;
    const projectedError = captureError(() => projectToolResult("team_create", invalid));
    const assembledError = captureError(() => assembleToolResult("team_create", invalid));

    expect({ name: assembledError.name, message: assembledError.message }).toEqual({
      name: projectedError.name,
      message: projectedError.message,
    });
    expect(assembledError.message).toBe("Invalid semantic result for team_create.");
  });

  it("keeps assembly and projection noncanonical-version errors identical and first", () => {
    const noncanonical = {
      kind: "task_read_batch",
      outcomes: [{
        kind: "found",
        input_index: 0,
        task_id: "task-1",
        task: {
          id: "task-1",
          title: "Verify",
          goal: "Verify the release.",
          status: "open",
          current_context: "Not started.",
          version: "legacy-v1",
        },
      }],
    } as any;
    const projectedError = captureError(() => projectToolResult("task_read", noncanonical));
    const assembledError = captureError(() => assembleToolResult("task_read", noncanonical));

    expect({ name: assembledError.name, message: assembledError.message }).toEqual({
      name: projectedError.name,
      message: projectedError.message,
    });
    expect(assembledError).toMatchObject({
      name: "upgrade_required",
      message: "Task result contains a non-canonical version; run the stopped-epoch migration.",
    });
  });

  it("validates and projects every catalog example without changing raw details", () => {
    for (const tool of modelToolCatalog.tools) {
      for (const example of tool.examples) {
        const model = projectToolResult(tool.name, example.result);
        expect(Check(ModelResultSchemas[tool.name], model), `${tool.name}:${example.id}`).toBe(true);
        expect(parseToolResult(tool.name, serializeToolResult(tool.name, example.result))).toEqual(model);
        expect(projectTui({ tool: tool.name, details: example.result, expanded: false }).join("\n")).not.toContain(JSON.stringify(example.result));
      }
    }
  });

  it("flattens singleton Task batches and preserves ordered multi-item batches", () => {
    const task = {
      id: "task-1",
      title: "Verify",
      goal: "g".repeat(1_000),
      status: "open" as const,
      current_context: "Not started.",
      version: taskVersionRef("v1"),
    };
    const singleton = { kind: "task_create_batch" as const, outcomes: [{ kind: "created" as const, input_index: 0, operation_id: "create-task-1", task }] };
    const projected = projectToolResult("task_create", singleton) as any;
    expect(projected).toEqual({ kind: "created", operation_id: "create-task-1", task: { id: "task-1", status: "open", version: taskVersionRef("v1") } });
    expect(Check(TaskCreateResultSchema, singleton)).toBe(true);

    const read = { kind: "task_read_batch" as const, outcomes: [
      { kind: "found" as const, input_index: 0, task_id: task.id, task },
      { kind: "missing" as const, input_index: 1, task_id: "missing", reason: "task_not_found" as const, state_changed: false as const },
    ] };
    const projectedRead = projectToolResult("task_read", read) as any;
    expect(projectedRead.outcomes).toHaveLength(2);
    expect(projectedRead.outcomes[0].task.goal).toHaveLength(1_000);
    expect(Check(TaskReadResultSchema, read)).toBe(true);
    expect(Check(ModelResultSchemas.task_read, projectedRead)).toBe(true);
  });

  it("keeps unknown create outcomes retryable with the same operation", () => {
    const unknown = {
      kind: "task_create_batch" as const,
      outcomes: [{
        kind: "unknown_outcome" as const,
        input_index: 0,
        operation_id: "create-retry-1",
        message: "Authority may have committed before transport ended.",
      }],
    };
    const model = projectToolResult("task_create", unknown) as any;
    expect(model).toEqual({
      kind: "unknown_outcome",
      operation_id: "create-retry-1",
      message: unknown.outcomes[0].message,
      recovery: { action: "retry_same_operation", operation_id: "create-retry-1" },
    });
    expect(projectTui({ tool: "task_create", details: unknown, expanded: false }).join("\n")).toMatch(/retry create operation.*create-retry-1/i);
  });

  it("keeps exact conflict and sync recovery coordinates", () => {
    const currentTask = {
      id: "task-1", title: "Verify", goal: "Verify the release.", status: "in_progress" as const,
      current_context: "Worker is verifying.", version: taskVersionRef("v4"),
    };
    const conflict = { kind: "task_update_batch" as const, outcomes: [{
      kind: "refused" as const, input_index: 0, task_id: "task-1", operation_id: "op-2",
      reason: "version_conflict" as const, message: "Stale version.", current_task: currentTask, state_changed: false as const,
    }] };
    const model = projectToolResult("task_update", conflict) as any;
    expect(model).toMatchObject({ kind: "refused", current_task: { ...currentTask, version: taskVersionRef("v4") } });
    expect(model.recovery).toEqual({ action: "reconcile_and_retry", expected_version: taskVersionRef("v4") });
    expect(Check(TaskUpdateResultSchema, conflict)).toBe(true);

    const gap = { kind: "contract_gap" as const, reason: "structured_task_event_evidence_absent" as const, message: "Events lack structured Task evidence.", state_changed: false as const, observation_advanced: false as const };
    expect(projectToolResult("team_sync", gap)).toEqual({ kind: "contract_gap", reason: gap.reason, message: gap.message, recovery: { action: "request_snapshot" } });
  });

  it("keeps partial lifecycle, delivery, and batch outcomes visibly partial", () => {
    const shutdown = {
      kind: "partial" as const,
      lifecycle: "active" as const,
      stopped_workers: ["idle"],
      failed_workers: ["blocked"],
      unfinished_task_ids: ["task-9"],
      state_changed: true as const,
    };
    expect(projectToolResult("team_shutdown", shutdown)).toEqual({
      kind: "partial",
      lifecycle: "active",
      stopped_workers: ["idle"],
      failed_workers: ["blocked"],
      unfinished_task_ids: ["task-9"],
      recovery: { action: "retry_team_shutdown" },
    });
    expect(projectTui({ tool: "team_shutdown", details: shutdown, expanded: true }).join("\n")).toMatch(/failed blocked|unfinished Tasks: task-9|partial/);

    const alert = {
      kind: "alert_sent" as const,
      alert_id: "alert-1",
      accepted_recipients: ["reviewer"],
      failed_recipients: ["offline"],
      task_state_changed: false as const,
    };
    expect(projectTui({ tool: "alert_send", details: alert, expanded: false }).join("\n")).toMatch(/partial|offline/);

    const mixed = { kind: "task_update_batch" as const, outcomes: [
      { kind: "updated" as const, input_index: 0, task_id: "task-1", operation_id: "op-1", task: { id: "task-1", title: "One", goal: "One goal", status: "closed" as const, current_context: "Done", version: taskVersionRef("v2") }, journal_entries: [] },
      { kind: "refused" as const, input_index: 1, task_id: "task-2", operation_id: "op-2", reason: "operation_conflict" as const, message: "Operation already has a different receipt.", current_task: { id: "task-2", title: "Two", goal: "Two goal", status: "in_progress" as const, current_context: "Still running", version: taskVersionRef("v4") }, state_changed: false as const },
    ] };
    const projected = projectToolResult("task_update", mixed) as any;
    expect(projected.outcomes[1].recovery).toEqual({ action: "reconcile_and_retry", expected_version: taskVersionRef("v4"), new_operation_id: true });
    expect(projectTui({ tool: "task_update", details: mixed, expanded: false }).join("\n")).toMatch(/new operation_id/);
  });

  it("uses a read-before-retry action when a Task-link refusal has no current version", () => {
    const refusal = {
      kind: "refused" as const,
      task_id: "task-1",
      reason: "graph_conflict" as const,
      message: "The current graph rejects this relation.",
      state_changed: false as const,
    };
    expect(projectToolResult("task_link", refusal)).toEqual({
      kind: "refused",
      task_id: "task-1",
      reason: "graph_conflict",
      message: refusal.message,
      recovery: { action: "read_before_retry", task_id: "task-1" },
    });
  });

  it("keeps successful TUI results semantic and renders errors as raw reports", () => {
    const success = projectTui({
      tool: "team_create",
      content: [{ type: "text", text: "model content" }],
      details: { kind: "team_created", team: { name: "review", purpose: "Review the release.", lifecycle: "active" } },
      expanded: false,
    }).join("\n");
    expect(success).toContain('Team "review" is active.');
    expect(success).not.toContain("Raw report follows");

    const executionError = projectTui({
      tool: "task_create",
      content: [{ type: "text", text: "Invalid semantic result for task_create." }],
      details: { operation_id: "create-release" },
      expanded: false,
      isError: true,
    }).join("\n");
    expect(executionError).toContain("task_create execution error");
    expect(executionError).toContain("Raw report follows");
    expect(executionError).toContain("Invalid semantic result for task_create.");
    expect(executionError).toContain('"operation_id": "create-release"');
    expect(executionError).not.toContain("did not produce a semantic result");

    const malformedResult = projectTui({
      tool: "task_read",
      content: [{ type: "text", text: "unprojected content" }],
      details: { malformed: true },
      expanded: true,
    }).join("\n");
    expect(malformedResult).toContain("task_read result projection error");
    expect(malformedResult).toContain('"malformed": true');
    expect(malformedResult).toContain("unprojected content");
  });

  it("rejects invalid Alert target combinations before execution", () => {
    expect(Check(AlertSendParametersSchema, { target: { kind: "team" }, kind: "clarification", text: "No." })).toBe(false);
    expect(Check(AlertSendParametersSchema, { target: { kind: "worker", name: "reviewer" }, kind: "attention", text: "Please check." })).toBe(true);
  });
});
