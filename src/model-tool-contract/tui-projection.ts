import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { projectToolResult, type ProjectedTool } from "./result-projection";

export interface TuiInput {
  tool: ProjectedTool;
  content?: unknown;
  details: unknown;
  expanded: boolean;
  isError?: boolean;
}

const compact = (value: string, limit = 120): string => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
};
const quoted = (value: string): string => JSON.stringify(value);
const status = (value: any): string => value.status;
const owner = (value: any): string => value.assignee ? `@ ${value.assignee}` : "unassigned";

function taskLine(task: any): string {
  return `${quoted(task.id)} · ${status(task)} · ${owner(task)} · version ${task.version}`;
}

function recoveryLine(value: any): string | undefined {
  const recovery = value?.recovery;
  if (!recovery) return undefined;
  if (recovery.action === "reconcile_and_retry") return recovery.new_operation_id
    ? `Next: read the current Task, then retry at version ${recovery.expected_version} with a new operation_id.`
    : `Next: read the current Task, then retry at version ${recovery.expected_version}.`;
  if (recovery.action === "retry_same_operation") return `Next: retry create operation ${quoted(recovery.operation_id)} exactly; do not create a new operation.`;
  if (recovery.action === "read_before_retry") return `Next: read Task ${quoted(recovery.task_id)} before retrying.`;
  if (recovery.action === "request_snapshot") return "Next: request a Team snapshot before continuing.";
  if (recovery.action === "retry_team_shutdown") return "Next: resolve the named Worker stop failures, then retry Team shutdown.";
  if (recovery.action === "team_sync") return "Next: use team_sync to reconcile current Team state.";
  return undefined;
}

function toolLines(tool: ProjectedTool, raw: any, model: any, expanded: boolean): string[] {
  const lines: string[] = [];
  if (tool === "team_create") {
    if (model.kind === "team_created") lines.push(`Team ${quoted(model.team.name)} is active.`);
    else lines.push(`${model.kind} · ${model.reason}: ${compact(model.message)}`);
  } else if (tool === "ensure_worker") {
    if (model.kind === "worker_ensured") lines.push(`Worker ${quoted(model.worker.name)} ${model.effect} · carrier ${model.worker.carrier}.`);
    else if (model.kind === "refused") lines.push(`Worker ${quoted(model.existing_worker.name)} was not changed · scope conflict.`);
    else lines.push(`${model.kind} · ${model.reason}: ${compact(model.message)}`);
  } else if (tool === "task_graph_apply" || tool === "task_create") {
    if (model.kind === "task_graph_applied") {
      const entries = Object.entries(model.tasks_by_key) as Array<[string, any]>;
      lines.push(`${entries.length} Task graph committed · ${model.ready_task_ids.length} ready · graph ${model.graph_version} · operation ${quoted(model.operation_id)}${model.replayed ? " · replayed" : ""}.`);
      if (model.delivery_warnings?.length) lines.push(`Delivery warnings: ${model.delivery_warnings.join("; ")}.`);
      if (expanded) for (const [key, task] of entries) {
        lines.push(`${quoted(key)} → ${taskLine(task)} · model ${task.model} · ${task.needs.length ? `needs ${task.needs.join(", ")}` : "no prerequisites"}.`);
      }
    } else if (model.kind === "unknown_outcome") {
      lines.push(`unknown outcome · operation ${quoted(model.operation_id)}: ${compact(model.message)}`);
      const retry = recoveryLine(model);
      if (retry) lines.push(retry);
    }
    else lines.push(`${model.kind} · ${model.reason}: ${compact(model.message)}`);
  } else if (tool === "task_read") {
    if (model.kind === "task_read_batch") {
      const missing = model.outcomes.filter((item: any) => item.kind !== "found");
      lines.push(`${model.outcomes.length} Task results · ${missing.length} missing or incomplete.`);
      for (const item of missing) lines.push(`${item.kind} · Task ${quoted(item.task_id)}${item.message ? `: ${compact(item.message)}` : "."}`);
      if (expanded) for (const item of model.outcomes.filter((item: any) => item.task)) lines.push(`Task ${taskLine(item.task)} · ${compact(item.task.current_context)}.`);
    } else if (model.kind === "found") lines.push(`Task ${taskLine(model.task)} · ${compact(model.task.current_context)}.`);
    else lines.push(`${model.kind} · ${model.reason}: ${compact(model.message ?? `Task ${model.task_id} was not found.`)}`);
  } else if (tool === "task_update") {
    if (model.kind === "updated") {
      lines.push(`Task ${taskLine(model.task)} · ${model.transition}${model.replayed ? " · replayed" : ""}.`);
      if (model.failure_traversal) lines.push(`Failure edge ${quoted(model.failure_traversal.source_task_id)} → ${quoted(model.failure_traversal.target_task_id)} · traversal ${model.failure_traversal.traversal}.`);
      if (model.ready_task_ids.length) lines.push(`Ready Tasks: ${model.ready_task_ids.join(", ")}.`);
      if (model.delivery_warnings?.length) lines.push(`Delivery warnings: ${model.delivery_warnings.join("; ")}.`);
    } else lines.push(`${model.kind} · ${model.reason ?? "unknown outcome"}: ${compact(model.message)}`);
    const retry = recoveryLine(model);
    if (retry) lines.push(retry);
  } else if (tool === "team_sync") {
    if (model.kind === "snapshot") lines.push(`Snapshot: ${model.workers.length} Worker${model.workers.length === 1 ? "" : "s"}, ${model.tasks.length} Task${model.tasks.length === 1 ? "" : "s"}.`);
    else if (model.kind === "updates") {
      lines.push(`Updates: ${model.task_changes.length} Task change${model.task_changes.length === 1 ? "" : "s"}, ${model.worker_changes.length} Worker change${model.worker_changes.length === 1 ? "" : "s"}, ${model.alerts.length} Alert${model.alerts.length === 1 ? "" : "s"}.`);
      for (const change of model.task_changes.slice(0, 4)) {
        const blocker = change.journal_entries.find((entry: any) => entry.kind === "blocker");
        lines.push(`Task ${quoted(change.task_id)} changed · ${change.current.status}${change.current.assignee ? ` · @ ${change.current.assignee}` : " · unassigned"}${blocker ? ` · blocker: ${compact(blocker.text)}` : ""}.`);
      }
    }
    else if (model.kind === "caught_up") lines.push("Caught up: no current Worker producer requires a wait.");
    else lines.push(`${model.kind} · ${model.reason ?? "observation not advanced"}${model.message ? `: ${compact(model.message)}` : "."}`);
    const retry = recoveryLine(model);
    if (retry) lines.push(retry);
  } else if (tool === "task_link") {
    if (model.kind === "task_linked") lines.push(`${model.changed ? "Relation changed" : "Relation unchanged"}: Task ${quoted(model.task_id)} ${model.action} ${model.relation} ${quoted(model.target_id)} · version ${model.version}.`);
    else lines.push(`${model.kind} · ${model.reason}: ${compact(model.message)}`);
    const retry = recoveryLine(model);
    if (retry) lines.push(retry);
  } else if (tool === "alert_send") {
    if (model.kind === "alert_sent") {
      lines.push(model.failed_recipients.length > 0
        ? `Alert partially accepted by ${model.accepted_recipients.join(", ") || "no recipients"}; failed recipients: ${model.failed_recipients.join(", ")}. Task state unchanged.`
        : `Alert accepted by ${model.accepted_recipients.join(", ") || "no recipients"}; Task state unchanged.`);
    }
    else lines.push(`${model.kind} · ${model.reason}: ${compact(model.message)}`);
  } else if (tool === "worker_stop") {
    if (model.kind === "worker_stopped") lines.push(`Worker ${quoted(model.worker)} stopped; Task state unchanged.`);
    else if (model.kind === "refused") lines.push(`Worker ${quoted(model.worker)} was not stopped · ${model.reason}${model.guarding_task_ids?.length ? ` · guarding Tasks ${model.guarding_task_ids.join(", ")}` : ""}.`);
    else lines.push(`${model.kind} · ${model.reason}: ${compact(model.message)}`);
  } else if (tool === "team_shutdown") {
    if (model.kind === "team_shutdown") lines.push(`Team stopped · ${model.stopped_workers.length} Worker${model.stopped_workers.length === 1 ? "" : "s"} stopped · ${model.unfinished_task_ids.length} unfinished Task${model.unfinished_task_ids.length === 1 ? "" : "s"} retained.`);
    else if (model.kind === "partial") lines.push(`Team remains active · stopped ${model.stopped_workers.join(", ") || "no Workers"}; failed ${model.failed_workers.join(", ") || "no Workers"}; unfinished Tasks: ${model.unfinished_task_ids.join(", ") || "none"}.`);
    else lines.push(`${model.kind} · ${model.reason}: ${compact(model.message)}`);
    const retry = recoveryLine(model);
    if (retry) lines.push(retry);
  }
  if (expanded && (tool === "team_sync" || tool === "task_read") && model.kind === "snapshot") {
    for (const task of model.tasks) lines.push(`  ${taskLine(task)} · ${compact(task.current_context)}.`);
  }
  return lines;
}

function rawErrorLines(input: TuiInput, issue: "execution_error" | "result_projection_error"): string[] {
  const report = {
    tool: input.tool,
    issue,
    content: input.content ?? [],
    details: input.details,
  };
  const raw = JSON.stringify(report, null, 2) ?? String(report);
  return [
    `✗ ${input.tool} ${issue === "execution_error" ? "execution error" : "result projection error"}`,
    "  Raw report follows. Review sensitive fields before sharing.",
    ...raw.split("\n").map((line) => `  ${line}`),
  ];
}

export function projectTui(input: TuiInput): string[] {
  if (input.isError) return rawErrorLines(input, "execution_error");
  try {
    const model = projectToolResult(input.tool, input.details) as any;
    const kind = model.kind;
    const mixedTaskBatch = false;
    const partialTaskCreate = (input.tool === "task_graph_apply" || input.tool === "task_create")
      && kind === "task_graph_applied"
      && model.delivery_warnings?.length;
    const partialAlert = input.tool === "alert_send" && kind === "alert_sent" && model.failed_recipients.length > 0;
    const negative = ["refused", "unavailable", "contract_gap", "cancelled", "snapshot_required", "indeterminate", "partial"].includes(kind) || mixedTaskBatch || partialTaskCreate || partialAlert;
    const tone = negative ? "!" : "✓";
    return [`${tone} ${mixedTaskBatch || partialTaskCreate || partialAlert ? "partial" : kind}`, ...toolLines(input.tool, input.details, model, input.expanded).map((line) => `  ${line}`)];
  } catch {
    return rawErrorLines(input, "result_projection_error");
  }
}

export type RenderResult = NonNullable<ToolDefinition["renderResult"]>;

export function createToolResultRenderer(tool: ProjectedTool): RenderResult {
  return (result, options, _theme, context) => {
    const lines = projectTui({ tool, content: result.content, details: result.details, expanded: options.expanded, isError: (context as any)?.isError === true });
    return new Text(lines.join("\n"), 0, 0);
  };
}
