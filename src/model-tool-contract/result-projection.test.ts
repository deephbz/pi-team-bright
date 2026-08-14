import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  AlertSendParametersSchema,
  TaskGraphApplyResultSchema,
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

  it("projects one atomic Task graph and preserves DAG decision coordinates", () => {
    const task = {
      id: "task-1",
      title: "Verify",
      goal: "g".repeat(1_000),
      assignee: "verifier",
      model: "default" as const,
      needs: [],
      status: "ready" as const,
      state: { kind: "ready" as const },
      current_context: "Not started.",
      version: taskVersionRef("v1"),
      attempts_started: 0,
      relations: [],
      dependency_state: { kind: "ready" as const, active_blocker_ids: [] },
    };
    const applied = {
      kind: "task_graph_applied" as const,
      operation_id: "apply-task-1",
      graph_version: "g_0123456789abcdef",
      replayed: false,
      tasks_by_key: { verify: task },
      ready_task_ids: [task.id],
    };
    const projected = projectToolResult("task_graph_apply", applied) as any;
    expect(projected).toEqual({
      kind: "task_graph_applied",
      operation_id: "apply-task-1",
      graph_version: "g_0123456789abcdef",
      replayed: false,
      tasks_by_key: {
        verify: {
          id: "task-1",
          status: "ready",
          assignee: "verifier",
          model: "default",
          needs: [],
          state: { kind: "ready" },
          attempts_started: 0,
          version: taskVersionRef("v1"),
        },
      },
      ready_task_ids: ["task-1"],
    });
    expect(Check(TaskGraphApplyResultSchema, applied)).toBe(true);

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

  it("keeps unknown graph-apply outcomes retryable with the same operation", () => {
    const unknown = {
      kind: "unknown_outcome" as const,
      operation_id: "apply-retry-1",
      message: "Authority may have committed before transport ended.",
    };
    const model = projectToolResult("task_graph_apply", unknown) as any;
    expect(model).toEqual({
      kind: "unknown_outcome",
      operation_id: "apply-retry-1",
      message: unknown.message,
      recovery: { action: "retry_same_operation", operation_id: "apply-retry-1" },
    });
    expect(projectTui({ tool: "task_graph_apply", details: unknown, expanded: false }).join("\n")).toMatch(/retry create operation.*apply-retry-1/i);
  });

  it("keeps exact conflict and sync recovery coordinates", () => {
    const currentTask = {
      id: "task-1",
      title: "Verify",
      goal: "Verify the release.",
      assignee: "verifier",
      model: "capable" as const,
      needs: [],
      status: "in_progress" as const,
      state: { kind: "in_progress" as const, attempt_id: "task-1@1" },
      current_context: "Worker is verifying.",
      version: taskVersionRef("v4"),
      activation_key: "activation-task-1",
      current_attempt: {
        id: "task-1@1",
        ordinal: 1,
        resolved_model: "openai-codex/gpt-5.6-terra:medium",
        input_attempt_ids: {},
      },
      attempts_started: 1,
      relations: [],
      dependency_state: { kind: "ready" as const, active_blocker_ids: [] },
    };
    const conflict = {
      kind: "refused" as const,
      input_index: 0,
      task_id: "task-1",
      operation_id: "op-2",
      reason: "version_conflict" as const,
      message: "Stale version.",
      current_task: currentTask,
      state_changed: false as const,
    };
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

    const currentTask = {
      id: "task-2",
      title: "Two",
      goal: "Two goal",
      assignee: "verifier",
      model: "default" as const,
      needs: [],
      status: "in_progress" as const,
      state: { kind: "in_progress" as const, attempt_id: "task-2@1" },
      current_context: "Still running",
      version: taskVersionRef("v4"),
      activation_key: "activation-task-2",
      current_attempt: { id: "task-2@1", ordinal: 1, resolved_model: "default-model", input_attempt_ids: {} },
      attempts_started: 1,
    };
    const operationConflict = {
      kind: "refused" as const,
      input_index: 0,
      task_id: "task-2",
      operation_id: "op-2",
      reason: "operation_conflict" as const,
      message: "Operation already has a different receipt.",
      current_task: currentTask,
      state_changed: false as const,
    };
    const projected = projectToolResult("task_update", operationConflict) as any;
    expect(projected.recovery).toEqual({ action: "reconcile_and_retry", expected_version: taskVersionRef("v4"), new_operation_id: true });
    expect(projectTui({ tool: "task_update", details: operationConflict, expanded: false }).join("\n")).toMatch(/new operation_id/);
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
      tool: "task_graph_apply",
      content: [{ type: "text", text: "Invalid semantic result for task_graph_apply." }],
      details: { operation_id: "apply-release" },
      expanded: false,
      isError: true,
    }).join("\n");
    expect(executionError).toContain("[pi-team-bright.task_graph_apply]");
    expect(executionError).toContain("execution error");
    expect(executionError).toContain("Press Ctrl+O");
    expect(executionError).not.toContain("Invalid semantic result for task_graph_apply.");
    expect(executionError).not.toContain('"operation_id": "apply-release"');

    const expandedExecutionError = projectTui({
      tool: "task_graph_apply",
      content: [{ type: "text", text: "Invalid semantic result for task_graph_apply." }],
      details: { operation_id: "apply-release" },
      expanded: true,
      isError: true,
    }).join("\n");
    expect(expandedExecutionError).toContain("Invalid semantic result for task_graph_apply.");
    expect(expandedExecutionError).toContain('"operation_id": "apply-release"');

    const malformedResult = projectTui({
      tool: "task_read",
      content: [{ type: "text", text: "unprojected content" }],
      details: { malformed: true },
      expanded: true,
    }).join("\n");
    expect(malformedResult).toContain("[pi-team-bright.task_read]");
    expect(malformedResult).toContain("result projection error");
    expect(malformedResult).toContain('"malformed": true');
    expect(malformedResult).toContain("unprojected content");
  });

  it("rejects invalid Alert target combinations before execution", () => {
    expect(Check(AlertSendParametersSchema, { to: "*", kind: "clarification", text: "No." })).toBe(true);
    expect(Check(AlertSendParametersSchema, { to: "reviewer", kind: "attention", text: "Please check." })).toBe(true);
  });
});
