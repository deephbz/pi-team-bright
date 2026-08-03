import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  CandidateAlertSendParametersSchema,
  CandidateTaskCreateResultSchema,
  CandidateTaskReadResultSchema,
  CandidateTaskUpdateResultSchema,
  candidateModelToolCatalog,
} from "./catalog";
import {
  CandidateModelResultSchemas,
  parseCandidateToolResult,
  projectCandidateToolResult,
  serializeCandidateToolResult,
} from "./result-projection";
import { projectCandidateTui } from "./tui-projection";
import { taskVersionRef } from "./task-version-ref";

describe("raw semantic result projections", () => {
  it("validates and projects every catalog example without changing raw details", () => {
    for (const tool of candidateModelToolCatalog.tools) {
      for (const example of tool.examples) {
        const model = projectCandidateToolResult(tool.name, example.result);
        expect(Check(CandidateModelResultSchemas[tool.name], model), `${tool.name}:${example.id}`).toBe(true);
        expect(parseCandidateToolResult(tool.name, serializeCandidateToolResult(tool.name, example.result))).toEqual(model);
        expect(projectCandidateTui({ tool: tool.name, details: example.result, expanded: false }).join("\n")).not.toContain(JSON.stringify(example.result));
      }
    }
  });

  it("flattens singleton Task batches and preserves ordered multi-item batches", () => {
    const task = {
      id: "task-1",
      title: "Verify",
      goal: "Verify the release.",
      status: "open" as const,
      current_context: "Not started.",
      version: "v1",
    };
    const singleton = { kind: "task_create_batch" as const, outcomes: [{ kind: "created" as const, input_index: 0, task }] };
    const projected = projectCandidateToolResult("task_create", singleton) as any;
    expect(projected).toEqual({ kind: "created", task: { id: "task-1", status: "open", version: taskVersionRef("v1") } });
    expect(Check(CandidateTaskCreateResultSchema, singleton)).toBe(true);

    const read = { kind: "task_read_batch" as const, outcomes: [
      { kind: "found" as const, input_index: 0, task_id: task.id, task },
      { kind: "missing" as const, input_index: 1, task_id: "missing", reason: "task_not_found" as const, state_changed: false as const },
    ] };
    expect((projectCandidateToolResult("task_read", read) as any).outcomes).toHaveLength(2);
    expect(Check(CandidateTaskReadResultSchema, read)).toBe(true);
  });

  it("keeps exact conflict and sync recovery coordinates", () => {
    const currentTask = {
      id: "task-1", title: "Verify", goal: "Verify the release.", status: "in_progress" as const,
      current_context: "Worker is verifying.", version: "v4",
    };
    const conflict = { kind: "task_update_batch" as const, outcomes: [{
      kind: "refused" as const, input_index: 0, task_id: "task-1", operation_id: "op-2",
      reason: "version_conflict" as const, message: "Stale version.", current_task: currentTask, state_changed: false as const,
    }] };
    const model = projectCandidateToolResult("task_update", conflict) as any;
    expect(model).toMatchObject({ kind: "refused", current_task: { ...currentTask, version: taskVersionRef("v4") } });
    expect(model.recovery).toEqual({ action: "reconcile_and_retry", expected_version: taskVersionRef("v4") });
    expect(Check(CandidateTaskUpdateResultSchema, conflict)).toBe(true);

    const gap = { kind: "contract_gap" as const, reason: "structured_task_event_evidence_absent" as const, message: "Events lack structured Task evidence.", state_changed: false as const, observation_advanced: false as const };
    expect(projectCandidateToolResult("team_sync", gap)).toEqual({ kind: "contract_gap", reason: gap.reason, message: gap.message, recovery: { action: "request_snapshot" } });
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
    expect(projectCandidateToolResult("team_shutdown", shutdown)).toEqual({
      kind: "partial",
      lifecycle: "active",
      stopped_workers: ["idle"],
      failed_workers: ["blocked"],
      unfinished_task_ids: ["task-9"],
      recovery: { action: "retry_team_shutdown" },
    });
    expect(projectCandidateTui({ tool: "team_shutdown", details: shutdown, expanded: true }).join("\n")).toMatch(/failed blocked|unfinished Tasks: task-9|partial/);

    const alert = {
      kind: "alert_sent" as const,
      alert_id: "alert-1",
      accepted_recipients: ["reviewer"],
      failed_recipients: ["offline"],
      task_state_changed: false as const,
    };
    expect(projectCandidateTui({ tool: "alert_send", details: alert, expanded: false }).join("\n")).toMatch(/partial|offline/);

    const mixed = { kind: "task_update_batch" as const, outcomes: [
      { kind: "updated" as const, input_index: 0, task_id: "task-1", operation_id: "op-1", task: { id: "task-1", title: "One", goal: "One goal", status: "closed" as const, current_context: "Done", version: "v2" }, journal_entries: [] },
      { kind: "refused" as const, input_index: 1, task_id: "task-2", operation_id: "op-2", reason: "operation_conflict" as const, message: "Operation already has a different receipt.", current_task: { id: "task-2", title: "Two", goal: "Two goal", status: "in_progress" as const, current_context: "Still running", version: "v4" }, state_changed: false as const },
    ] };
    const projected = projectCandidateToolResult("task_update", mixed) as any;
    expect(projected.outcomes[1].recovery).toEqual({ action: "reconcile_and_retry", expected_version: taskVersionRef("v4"), new_operation_id: true });
    expect(projectCandidateTui({ tool: "task_update", details: mixed, expanded: false }).join("\n")).toMatch(/new operation_id/);
  });

  it("uses a read-before-retry action when a Task-link refusal has no current version", () => {
    const refusal = {
      kind: "refused" as const,
      task_id: "task-1",
      reason: "graph_conflict" as const,
      message: "The current graph rejects this relation.",
      state_changed: false as const,
    };
    expect(projectCandidateToolResult("task_link", refusal)).toEqual({
      kind: "refused",
      task_id: "task-1",
      reason: "graph_conflict",
      message: refusal.message,
      recovery: { action: "read_before_retry", task_id: "task-1" },
    });
  });

  it("rejects invalid Alert target combinations before execution", () => {
    expect(Check(CandidateAlertSendParametersSchema, { target: { kind: "team" }, kind: "clarification", text: "No." })).toBe(false);
    expect(Check(CandidateAlertSendParametersSchema, { target: { kind: "worker", name: "reviewer" }, kind: "attention", text: "Please check." })).toBe(true);
  });
});
