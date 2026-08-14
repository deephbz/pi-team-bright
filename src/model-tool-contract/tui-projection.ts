import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { projectToolResult, type ProjectedTool } from "./result-projection";
import {
  projectionLines,
  renderProjectionWithTheme,
  type PiTeamBrightTuiMessage,
  type TuiMessageTone,
} from "./tui-message-projection";

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

function toolLines(tool: ProjectedTool, model: any): string[] {
  const lines: string[] = [];
  if (tool === "team_create") {
    if (model.kind === "team_created") lines.push(`Team ${quoted(model.team.name)} is active.`);
    else lines.push(`${model.kind} · ${model.reason}: ${compact(model.message)}`);
  } else if (tool === "ensure_worker") {
    if (model.kind === "worker_ensured") lines.push(`Worker ${quoted(model.worker.name)} ${model.effect} · carrier ${model.worker.carrier}.`);
    else if (model.kind === "refused" && model.existing_worker) lines.push(`Worker ${quoted(model.existing_worker.name)} was not changed · scope conflict.`);
    else lines.push(`${model.kind} · ${model.reason}: ${compact(model.message)}`);
  } else if (tool === "task_graph_apply" || tool === "task_create") {
    if (model.kind === "task_graph_applied") {
      const entries = Object.entries(model.tasks_by_key) as Array<[string, any]>;
      lines.push(`${entries.length} Task graph committed · ${model.ready_task_ids.length} ready · graph ${model.graph_version} · operation ${quoted(model.operation_id)}${model.replayed ? " · replayed" : ""}.`);
      if (model.delivery_warnings?.length) lines.push(`Delivery warnings: ${model.delivery_warnings.join("; ")}.`);
    } else if (model.kind === "unknown_outcome") {
      lines.push(`unknown outcome · operation ${quoted(model.operation_id)}: ${compact(model.message)}`);
      const retry = recoveryLine(model);
      if (retry) lines.push(retry);
    } else lines.push(`${model.kind} · ${model.reason}: ${compact(model.message)}`);
  } else if (tool === "task_read") {
    if (model.kind === "task_read_batch") {
      const missing = model.outcomes.filter((item: any) => item.kind !== "found");
      lines.push(`${model.outcomes.length} Task results · ${missing.length} missing or incomplete.`);
      for (const item of missing.slice(0, 4)) lines.push(`${item.kind} · Task ${quoted(item.task_id)}${item.message ? `: ${compact(item.message)}` : "."}`);
    } else if (model.kind === "found") lines.push(`Task ${taskLine(model.task)} · ${compact(model.task.current_context)}.`);
    else lines.push(`${model.kind} · ${model.reason ?? "read failed"}: ${compact(model.message ?? `Task ${model.task_id ?? "unknown"} was not found.`)}`);
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
    } else if (model.kind === "caught_up") lines.push("Caught up: no current Worker producer requires a wait.");
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
    } else lines.push(`${model.kind} · ${model.reason}: ${compact(model.message)}`);
  } else if (tool === "worker_stop") {
    if (model.kind === "worker_stopped") lines.push(`Worker ${quoted(model.worker)} stopped; Task state unchanged.`);
    else if (model.kind === "refused" && model.worker) lines.push(`Worker ${quoted(model.worker)} was not stopped · ${model.reason}${model.guarding_task_ids?.length ? ` · guarding Tasks ${model.guarding_task_ids.join(", ")}` : ""}.`);
    else lines.push(`${model.kind} · ${model.reason}: ${compact(model.message)}`);
  } else if (tool === "team_shutdown") {
    if (model.kind === "team_shutdown") lines.push(`Team stopped · ${model.stopped_workers.length} Worker${model.stopped_workers.length === 1 ? "" : "s"} stopped · ${model.unfinished_task_ids.length} unfinished Task${model.unfinished_task_ids.length === 1 ? "" : "s"} retained.`);
    else if (model.kind === "partial") lines.push(`Team remains active · stopped ${model.stopped_workers.join(", ") || "no Workers"}; failed ${model.failed_workers.join(", ") || "no Workers"}; unfinished Tasks: ${model.unfinished_task_ids.join(", ") || "none"}.`);
    else lines.push(`${model.kind} · ${model.reason}: ${compact(model.message)}`);
    const retry = recoveryLine(model);
    if (retry) lines.push(retry);
  }
  return lines;
}

function toneFor(tool: ProjectedTool, model: any): { tone: TuiMessageTone; label: string } {
  const partialTaskGraph = (tool === "task_graph_apply" || tool === "task_create") && model.kind === "task_graph_applied" && model.delivery_warnings?.length;
  const partialAlert = tool === "alert_send" && model.kind === "alert_sent" && model.failed_recipients.length > 0;
  const warningKinds = ["missing", "refused", "unavailable", "contract_gap", "cancelled", "snapshot_required", "indeterminate", "partial", "unknown_outcome"];
  const warning = partialTaskGraph || partialAlert || warningKinds.includes(model.kind);
  return { tone: warning ? "warning" : "success", label: warning ? (partialTaskGraph || partialAlert ? "partial" : model.kind) : model.kind };
}

/** Project an already validated model result. The gallery uses this exhaustive seam. */
export function projectModelToolTuiMessage(tool: ProjectedTool, model: any, detail: unknown = model): PiTeamBrightTuiMessage {
  const { tone, label } = toneFor(tool, model);
  return {
    type: tool,
    tone,
    lines: [`${tone === "success" ? "✓" : "!"} ${label}`, ...toolLines(tool, model).map((line) => `  ${line}`)],
    detail,
    provenance: "tool-result",
  };
}

function errorMessage(input: TuiInput, issue: "execution_error" | "result_projection_error"): PiTeamBrightTuiMessage {
  const report = { tool: input.tool, issue, content: input.content ?? [], details: input.details };
  return {
    type: input.tool,
    tone: "error",
    lines: [
      `✗ ${issue === "execution_error" ? "execution error" : "result projection error"}`,
      "  Press Ctrl+O to inspect the raw JSON report. Review sensitive fields before sharing.",
    ],
    detail: report,
    provenance: "tool-result",
  };
}

export function projectToolTuiMessage(input: TuiInput): PiTeamBrightTuiMessage {
  if (input.isError) return errorMessage(input, "execution_error");
  try {
    return projectModelToolTuiMessage(input.tool, projectToolResult(input.tool, input.details), input.details);
  } catch {
    return errorMessage(input, "result_projection_error");
  }
}

/** Full plain projection used by tests and non-Pi exporters. */
export function projectTui(input: TuiInput): string[] {
  return projectionLines(projectToolTuiMessage(input), { expanded: input.expanded });
}

export type RenderCall = NonNullable<ToolDefinition["renderCall"]>;
export type RenderResult = NonNullable<ToolDefinition["renderResult"]>;

export function createToolCallRenderer(tool: ProjectedTool): RenderCall {
  return (_args, theme) => renderProjectionWithTheme({
    type: tool,
    tone: "info",
    lines: [],
    detail: null,
    provenance: "tool-result",
  }, { expanded: false }, theme);
}

export function createToolResultRenderer(tool: ProjectedTool): RenderResult {
  return (result, options, theme, context) => renderProjectionWithTheme(
    projectToolTuiMessage({
      tool,
      content: result.content,
      details: result.details,
      expanded: options.expanded,
      isError: (context as any)?.isError === true,
    }),
    { expanded: options.expanded, includeHeader: false },
    theme,
  );
}
