import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  PI_TEAMS_TOOL_RESULT_SCHEMA,
  type PiTeamsToolResultDetails,
  type ToolResultNextAction,
  type ToolResultOutcome,
  type ToolResultResource,
  type ToolResultWarning,
} from "./tool-results";

export const PI_TEAMS_PUBLIC_TOOLS = [
  "team_create",
  "team_sync",
  "team_shutdown",
  "worker_ensure",
  "worker_stop",
  "task_create",
  "task_read",
  "task_update",
  "task_link",
  "alert_send",
] as const;

export type PiTeamsPublicTool = (typeof PI_TEAMS_PUBLIC_TOOLS)[number];

type LineTone = "success" | "warning" | "error" | "accent" | "muted" | "dim";

export interface ToolResultRenderLine {
  tone: LineTone;
  text: string;
  italic?: boolean;
}

export interface FormatPiTeamsToolResultInput {
  tool: PiTeamsPublicTool;
  details?: unknown;
  args?: unknown;
  content?: unknown;
  expanded: boolean;
  isPartial?: boolean;
  isError?: boolean;
}

interface NormalizedResult {
  outcome: ToolResultOutcome;
  operation: string;
  resource?: ToolResultResource;
  postState?: unknown;
  warnings: ToolResultWarning[];
  nextActions: ToolResultNextAction[];
  evidence?: unknown;
  diagnostics?: unknown;
  legacy: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstString(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function bounded(value: string, limit = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

function modelContentLines(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const text = content.find((item) => isRecord(item) && item.type === "text");
  if (!isRecord(text) || typeof text.text !== "string" || text.text.length === 0) return [];
  return text.text.split("\n");
}

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content.find((item) => isRecord(item) && item.type === "text");
  if (!isRecord(text) || typeof text.text !== "string") return undefined;
  const trimmed = text.text.trim();
  // A renderer must never turn serialized machine state back into the human
  // fallback. Only a plain-language execution error is safe to reuse.
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return undefined;
  return bounded(trimmed);
}

function validOutcome(value: unknown): value is ToolResultOutcome {
  return value === "accepted" || value === "partial" || value === "refused";
}

function normalizeWarnings(value: unknown): ToolResultWarning[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (typeof item === "string") {
      return [{ code: `legacy_warning_${index + 1}`, message: bounded(item) }];
    }
    if (!isRecord(item) || typeof item.message !== "string") return [];
    return [{
      code: stringValue(item.code) ?? `warning_${index + 1}`,
      message: bounded(item.message),
      ...(stringValue(item.resourceId) ? { resourceId: String(item.resourceId) } : {}),
    }];
  });
}

function normalizeNextActions(value: unknown): ToolResultNextAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.tool !== "string" || typeof item.reason !== "string") return [];
    return [{
      tool: item.tool,
      reason: bounded(item.reason),
      ...(isRecord(item.args) ? { args: item.args } : {}),
    }];
  });
}

function normalizeResource(value: unknown): ToolResultResource | undefined {
  if (!isRecord(value)) return undefined;
  if (!["team", "worker", "task", "alert"].includes(String(value.kind))) return undefined;
  if (typeof value.id !== "string" || !value.id) return undefined;
  return {
    kind: value.kind as ToolResultResource["kind"],
    id: value.id,
    ...(stringValue(value.teamName) ? { teamName: String(value.teamName) } : {}),
  };
}

function envelope(details: unknown): PiTeamsToolResultDetails | undefined {
  if (!isRecord(details) || details.schema !== PI_TEAMS_TOOL_RESULT_SCHEMA) return undefined;
  if (!validOutcome(details.outcome) || typeof details.operation !== "string") return undefined;
  return details as unknown as PiTeamsToolResultDetails;
}

function legacyTask(details: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(details.task)) return details.task;
  if (isRecord(details.postState) && isRecord(details.postState.task)) return details.postState.task;
  return undefined;
}

function legacyResource(
  tool: PiTeamsPublicTool,
  details: Record<string, unknown>,
  args: Record<string, unknown>,
): ToolResultResource | undefined {
  const receipt = isRecord(details.receipt) ? details.receipt : undefined;
  const receiptResource = normalizeResource(receipt?.resource);
  if (receiptResource) return receiptResource;
  const task = legacyTask(details);
  const teamName = firstString(args, "team_name")
    ?? firstString(isRecord(details.projection) && isRecord(details.projection.team) ? details.projection.team : undefined, "name");

  if (tool.startsWith("task_")) {
    const id = firstString(task, "id") ?? firstString(args, "task_id");
    return id ? { kind: "task", id, ...(teamName ? { teamName } : {}) } : undefined;
  }
  if (tool.startsWith("worker_")) {
    const worker = isRecord(details.worker) ? details.worker : undefined;
    const membership = isRecord(details.membership) ? details.membership : undefined;
    const id = firstString(worker, "name") ?? firstString(membership, "agentName") ?? firstString(args, "name", "worker");
    return id ? { kind: "worker", id, ...(teamName ? { teamName } : {}) } : undefined;
  }
  if (tool === "alert_send") {
    const id = firstString(details, "alertId") ?? firstString(args, "task_id") ?? firstString(args, "to") ?? "alert";
    return { kind: "alert", id, ...(teamName ? { teamName } : {}) };
  }
  if (teamName) return { kind: "team", id: teamName, teamName };
  return undefined;
}

function normalizeLegacy(
  tool: PiTeamsPublicTool,
  detailsValue: unknown,
  argsValue: unknown,
  content: unknown,
  isError: boolean,
): NormalizedResult {
  const details = isRecord(detailsValue) ? detailsValue : {};
  const args = isRecord(argsValue) ? argsValue : {};
  const receipt = isRecord(details.receipt) ? details.receipt : undefined;
  const failures = Array.isArray(details.failures) ? details.failures : [];
  const receiptWarnings = normalizeWarnings(receipt?.warnings);
  const deliveryWarnings = normalizeWarnings(details.deliveryWarnings);
  const failureWarnings = failures.flatMap((failure, index) => {
    if (!isRecord(failure)) return [];
    const message = firstString(failure, "error", "message");
    if (!message) return [];
    return [{
      code: `delivery_failure_${index + 1}`,
      message: bounded(message),
      ...(firstString(failure, "name", "recipient") ? { resourceId: firstString(failure, "name", "recipient") } : {}),
    } satisfies ToolResultWarning];
  });
  const plainError = isError ? contentText(content) : undefined;
  const warnings = [
    ...receiptWarnings,
    ...deliveryWarnings,
    ...failureWarnings,
    ...(plainError ? [{ code: "execution_error", message: plainError }] : []),
  ];
  if (!isError && Object.keys(details).length === 0) {
    warnings.push({ code: "structured_evidence_unavailable", message: "Structured result evidence is unavailable." });
  }

  const task = legacyTask(details);
  const projection = details.projection;
  const postState = task
    ?? projection
    ?? (isRecord(receipt?.postState) ? receipt.postState : undefined)
    ?? (Object.keys(details).length > 0 ? details : undefined);
  const nextAction = stringValue(receipt?.nextAction);
  return {
    outcome: isError ? "refused" : failures.length > 0 ? "partial" : "accepted",
    operation: tool,
    resource: legacyResource(tool, details, args),
    postState,
    warnings,
    nextActions: nextAction ? [{ tool: "follow_up", reason: nextAction }] : [],
    evidence: isRecord(details.stopEvidence) || Array.isArray(details.stopEvidence)
      ? details.stopEvidence
      : undefined,
    diagnostics: undefined,
    legacy: true,
  };
}

function normalize(input: FormatPiTeamsToolResultInput): NormalizedResult {
  const current = envelope(input.details);
  if (!current) {
    return normalizeLegacy(input.tool, input.details, input.args, input.content, !!input.isError);
  }
  const warnings = normalizeWarnings(current.warnings);
  if (current.operation !== input.tool) {
    warnings.unshift({
      code: "operation_mismatch",
      message: `Result operation ${current.operation} did not match renderer operation ${input.tool}.`,
    });
  }
  return {
    outcome: current.outcome,
    operation: input.tool,
    resource: normalizeResource(current.resource),
    postState: current.postState,
    warnings,
    nextActions: normalizeNextActions(current.nextActions),
    evidence: current.evidence,
    diagnostics: current.diagnostics,
    legacy: false,
  };
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return bounded(value, 240);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (value === null) return "none";
  return undefined;
}

function structuredLines(value: unknown, prefix = "", depth = 0): string[] {
  if (depth > 3) return [`${prefix || "Value"}: …`];
  const direct = scalar(value);
  if (direct !== undefined) return [`${prefix || "Value"}: ${direct}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix || "Items"}: none`];
    return value.slice(0, 12).flatMap((item, index) => {
      const itemPrefix = `${prefix || "Item"} ${index + 1}`;
      return structuredLines(item, itemPrefix, depth + 1);
    }).concat(value.length > 12 ? [`${prefix || "Items"}: ${value.length - 12} more`] : []);
  }
  if (!isRecord(value)) return [`${prefix || "Value"}: unavailable`];
  const entries = Object.entries(value);
  if (entries.length === 0) return [`${prefix || "Value"}: none`];
  return entries.slice(0, 24).flatMap(([key, item]) => {
    const itemPrefix = prefix ? `${prefix} · ${humanizeKey(key)}` : humanizeKey(key);
    return structuredLines(item, itemPrefix, depth + 1);
  }).concat(entries.length > 24 ? [`${prefix || "Fields"}: ${entries.length - 24} more`] : []);
}

function humanExpandedEvidence(tool: PiTeamsPublicTool, value: unknown): unknown {
  if (tool !== "team_sync" || !isRecord(value) || !Array.isArray(value.events)) return value;
  return {
    ...value,
    events: value.events.map((event) => {
      if (!isRecord(event) || event.type !== "worker") return event;
      const { membershipId: _opaqueMembershipId, ...semanticEvent } = event;
      return semanticEvent;
    }),
  };
}

function receiptIdentity(
  tool: PiTeamsPublicTool,
  normalized: NormalizedResult,
  argsValue: unknown,
): string {
  const args = isRecord(argsValue) ? argsValue : {};
  const postState = isRecord(normalized.postState) ? normalized.postState : undefined;
  const teamName = normalized.resource?.teamName ?? firstString(args, "team_name");
  const teamSuffix = teamName && normalized.resource?.id !== teamName ? ` · team ${JSON.stringify(teamName)}` : "";

  if (tool === "alert_send") {
    const kind = firstString(postState, "kind") ?? firstString(args, "kind") ?? "alert";
    const to = firstString(postState, "to", "recipient") ?? firstString(args, "to") ?? "recipient";
    const taskId = firstString(postState, "taskId", "task_id") ?? firstString(args, "task_id");
    return `${kind} alert to ${JSON.stringify(to)}${taskId ? ` · task ${JSON.stringify(taskId)}` : ""}${teamName ? ` · team ${JSON.stringify(teamName)}` : ""}`;
  }
  if (tool === "task_link") {
    const taskId = normalized.resource?.id ?? firstString(args, "task_id") ?? "unknown";
    const relation = firstString(args, "relation") ?? "relation";
    const target = firstString(args, "target_id") ?? "target";
    const action = firstString(args, "action") ?? "change";
    const evidence = isRecord(normalized.evidence) ? normalized.evidence : {};
    const prefix = normalized.outcome === "refused" && evidence.changed === false ? "requested " : "";
    return `task ${JSON.stringify(taskId)} · ${prefix}${action} ${relation} → ${JSON.stringify(target)}${teamSuffix}`;
  }
  if (normalized.resource) {
    return `${normalized.resource.kind} ${JSON.stringify(normalized.resource.id)}${teamSuffix}`;
  }
  if (teamName) return `team ${JSON.stringify(teamName)}`;
  return "result";
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

function semanticState(tool: PiTeamsPublicTool, postState: unknown): string | undefined {
  if (!isRecord(postState)) return undefined;
  if (postState.timedOut === true) return "timed out";
  // The outcome already owns partial/accepted/refused in the header. For
  // shutdowns, lifecycle is the distinct authority fact worth surfacing.
  if (tool === "team_shutdown") return firstString(postState, "lifecycle", "state");
  return firstString(postState, "completion", "shutdownOutcome", "action", "status", "lifecycle", "state", "carrier", "phase");
}

function compactFacts(tool: PiTeamsPublicTool, normalized: NormalizedResult): string[] {
  const state = isRecord(normalized.postState) ? normalized.postState : {};
  const evidence = isRecord(normalized.evidence) ? normalized.evidence : {};
  const owner = state.assignee === null || state.assignee === undefined ? "unassigned" : String(state.assignee);

  if (tool === "team_create") {
    if (state.changed === false) return [`Current members: ${Array.isArray(state.currentMembers) ? state.currentMembers.join(", ") : "unchanged"}`];
    const taskWorkspace = firstString(state, "taskWorkspace") ?? firstString(state, "teamDirectory");
    return [
      taskWorkspace
        ? `Task engine: Beads · workspace: ${taskWorkspace} · external view/edit: bd --directory <workspace> …`
        : state.taskAuthorityReady === true ? "Task engine: Beads · ready" : "",
    ].filter(Boolean);
  }
  if (tool === "worker_ensure") {
    if (state.changed === false) return ["Worker not created · current roster unchanged"];
    if (state.action === "reused") {
      const nonterminalTasks = Array.isArray(state.nonterminalTasks) ? state.nonterminalTasks : undefined;
      return [
        `Carrier: ${firstString(state, "carrier") ?? "unknown"}${nonterminalTasks?.length === 0 ? " · State: idle · no nonterminal Task" : nonterminalTasks ? ` · ${nonterminalTasks.length} nonterminal ${nonterminalTasks.length === 1 ? "Task" : "Tasks"}` : ""}`,
      ];
    }
    return [
      `Carrier: ${firstString(state, "carrier") ?? "unknown"} · Runtime: ${firstString(state, "runtime") ?? "not observed"}`,
    ];
  }
  if (tool === "worker_stop") {
    const guards = Array.isArray(state.guardingTasks)
      ? state.guardingTasks.flatMap((item) => isRecord(item) && stringValue(item.id) ? [String(item.id)] : [])
      : [];
    return guards.length > 0 ? [`Guarding Tasks: ${guards.join(", ")} · Worker unchanged`] : ["No Task state changed"];
  }
  if (tool === "team_sync") {
    if (state.changed === false) {
      const reason = firstString(state, "reason");
      if (reason === "cursor_ahead_of_journal") {
        return [
          `Current cursor: ${firstString(state, "journalHeadCursor") ?? "unavailable"} · Wait not started`,
          "Team, Worker, Task, and event state unchanged · No events consumed or lost",
        ];
      }
      if (reason === "invalid_cursor") return ["Wait not started · Team and Task state unchanged"];
      return ["Current Team and Task projection not returned · State unchanged"];
    }
    const projection = isRecord(state.projection) ? state.projection : {};
    const workers = Array.isArray(projection.workers) ? projection.workers : [];
    const tasks = Array.isArray(projection.tasks) ? projection.tasks : [];
    const events = Array.isArray(evidence.events) ? evidence.events : [];
    const completion = firstString(state, "completion") ?? "snapshot";
    if (completion === "timeout") return ["No matching changes before timeout"];
    if (completion === "events") {
      const hydrated = Array.isArray(state.hydratedTasks) ? state.hydratedTasks : [];
      const changed = hydrated.slice(0, 3).flatMap((item) => {
        if (!isRecord(item) || !stringValue(item.id)) return [];
        const relations = Array.isArray(item.relations)
          ? item.relations.flatMap((relation) => isRecord(relation) && stringValue(relation.relation) && stringValue(relation.targetId)
            ? [`${relation.relation === "blocked_by" ? "blocked by" : relation.relation} ${relation.targetId}`]
            : [])
          : [];
        const status = firstString(item, "status") ?? "changed";
        const ownerText = stringValue(item.assignee) ? `@ ${item.assignee}` : "unassigned";
        const blocker = status === "blocked" && stringValue(item.notes) ? ` · Blocker: ${bounded(String(item.notes), 150)}` : "";
        return [`${item.id}: ${status} · ${ownerText}${relations.length ? ` · ${relations.join(", ")}` : ""}${blocker}`];
      });
      const groupedChanges = new Map<string, { text: string; count: number }>();
      for (const event of events) {
        if (!isRecord(event)) continue;
        let key: string | undefined;
        let text: string | undefined;
        if (event.type === "task") {
          const ref = isRecord(event.ref) ? event.ref : undefined;
          const taskId = firstString(ref, "taskId") ?? "unknown";
          const change = firstString(event, "change");
          const actor = firstString(event, "actor");
          if (change) {
            key = `task\0${taskId}\0${change}\0${actor ?? ""}`;
            text = `Observed ${change} event for Task ${taskId}${actor ? ` by ${actor}` : ""}`;
          }
        } else if (event.type === "worker") {
          const worker = firstString(event, "worker") ?? "unknown";
          const phase = firstString(event, "phase") ?? "change";
          key = `worker\0${worker}\0${phase}`;
          text = `Worker ${worker} ${phase}`;
        } else if (event.type === "alert") {
          const kind = firstString(event, "kind") ?? "alert";
          const from = firstString(event, "from") ?? "unknown";
          const to = firstString(event, "to") ?? "unknown";
          const taskRef = isRecord(event.taskRef) ? event.taskRef : undefined;
          const taskId = firstString(taskRef, "taskId");
          key = `alert\0${kind}\0${from}\0${to}\0${taskId ?? ""}`;
          text = `${humanizeKey(kind)} Alert ${from} → ${to}${taskId ? ` · Task ${taskId}` : ""}`;
        }
        if (!key || !text) continue;
        const group = groupedChanges.get(key);
        groupedChanges.set(key, { text, count: (group?.count ?? 0) + 1 });
      }
      const changes = [...groupedChanges.values()].map((group) => `${group.text}${group.count > 1 ? ` ×${group.count}` : ""}`);
      const idle = workers.flatMap((worker) => {
        if (!isRecord(worker) || !stringValue(worker.name) || !Array.isArray(worker.nonterminalTasks) || worker.nonterminalTasks.length > 0) return [];
        return [String(worker.name)];
      });
      const pagination = isRecord(state.pagination) && isRecord(state.pagination.events) ? state.pagination.events : {};
      const remaining = typeof pagination.remaining === "number" ? pagination.remaining : 0;
      const truncated = pagination.truncated === true;
      return [
        `Cursor ${firstString(state, "cursor") ?? "?"} · ${events.length} event${events.length === 1 ? "" : "s"}${truncated ? ` returned · ${remaining} remaining · truncated` : ""}${changes.length ? `: ${changes.join(", ")}` : ""}`,
        ...changed.map((fact) => `Current Task ${fact}`),
        ...(idle.length ? [`Idle Workers: ${idle.join(", ")}`] : []),
      ];
    }
    const workerNames = workers.slice(0, 4).flatMap((item) => isRecord(item) && stringValue(item.name)
      ? [`${item.name} (${firstString(item, "carrier") ?? "unknown"})`]
      : []);
    const statusCounts = new Map<string, number>();
    for (const item of tasks) {
      if (!isRecord(item)) continue;
      const status = firstString(item, "status") ?? "unknown";
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    }
    const counts = [...statusCounts].map(([status, count]) => `${count} ${status}`).join(" · ");
    const taskNames = tasks.slice(0, 3).flatMap((item) => {
      if (!isRecord(item) || !stringValue(item.id)) return [];
      const title = firstString(item, "title");
      const status = firstString(item, "status") ?? "unknown";
      const taskOwner = stringValue(item.assignee) ? `@ ${item.assignee}` : "unassigned";
      return [`${item.id}${title ? ` “${bounded(title, 60)}”` : ""} ${status} · ${taskOwner}`];
    });
    return [
      `${workers.length} Workers${workerNames.length ? `: ${workerNames.join(", ")}` : ""}`,
      `${tasks.length} Tasks${taskNames.length ? ` · ${taskNames.join("; ")}` : counts ? `: ${counts}` : ""}`,
    ];
  }
  if (tool === "alert_send") {
    if (state.accepted === false) return ["No delivery accepted · Task state unchanged"];
    const recipients = Array.isArray(state.recipients) ? state.recipients.join(", ") : firstString(state, "to") ?? "none";
    return [`Accepted by: ${recipients} · Task state unchanged`];
  }
  if (["task_create", "task_read", "task_update"].includes(tool)) {
    if (tool === "task_create" && state.created === false) return ["Task not created · Team Task state unchanged"];
    if (state.found === false) return ["Task not found · No state changed"];
    const title = firstString(state, "title");
    const status = firstString(state, "status");
    const facts = [`${title ? `“${bounded(title, 90)}” · ` : ""}${status ?? "unknown"} · ${owner}`];
    if (tool === "task_update" && isRecord(evidence.before)) {
      const beforeStatus = firstString(evidence.before, "status");
      const beforeOwner = evidence.before.assignee === null || evidence.before.assignee === undefined
        ? "unassigned"
        : String(evidence.before.assignee);
      if (beforeStatus && (beforeStatus !== status || beforeOwner !== owner)) {
        facts.push(`Transition: ${beforeStatus} · ${beforeOwner} → ${status ?? "unknown"} · ${owner}`);
      }
    }
    if (tool === "task_update" && normalized.warnings.length === 0) facts.push("Delivery warnings: none");
    if (tool === "task_update" && status === "blocked") {
      const blocker = stringValue(state.notes);
      facts.push(blocker
        ? `Blocker: ${bounded(blocker, 180)}`
        : state.assignee === null ? "Blocker evidence recorded · coordinator action required" : "Blocker evidence recorded");
    }
    if (tool === "task_read") {
      facts.push(`Intent: ${bounded(stringValue(state.description) ?? "not specified", 160)}`);
      facts.push(`Acceptance: ${bounded(stringValue(state.acceptanceCriteria) ?? "not specified", 160)}`);
      const relations = Array.isArray(state.relations)
        ? state.relations.flatMap((relation) => isRecord(relation) && stringValue(relation.relation) && stringValue(relation.targetId)
          ? [`${relation.relation} ${relation.targetId}`]
          : [])
        : [];
      facts.push(`Relations: ${relations.length ? relations.join(", ") : "none"} · Design: ${stringValue(state.design) ? "defined" : "not specified"} · Notes: ${stringValue(state.notes) ? "present" : "none"}`);
    }
    return facts;
  }
  if (tool === "task_link") {
    const changed = evidence.changed;
    if (changed === false) {
      const reason = firstString(evidence, "noOpReason");
      if (reason === "already_present") return ["Task unchanged · relation already present · delivery not attempted"];
      if (reason === "already_absent") return ["Task unchanged · relation already absent · delivery not attempted"];
      const conflictReason = firstString(evidence, "conflictReason");
      return normalized.outcome === "refused"
        ? [`No relation change · ${conflictReason === "stale_version" ? "stale version conflict" : "graph invariant conflict"}`]
        : ["No relation change"];
    }
    return changed === true ? ["Relation change applied"] : [];
  }
  if (tool === "team_shutdown") {
    const stopped = typeof state.stoppedWorkers === "number" ? state.stoppedWorkers : 0;
    const failures = Array.isArray(state.failures) ? state.failures : [];
    const unfinished = Array.isArray(state.unfinishedTasks) ? state.unfinishedTasks.length : 0;
    const stoppedNames = Array.isArray(state.stoppedWorkerNames) ? state.stoppedWorkerNames.join(", ") : "";
    const currentNames = Array.isArray(state.currentMembers) ? state.currentMembers.join(", ") : "";
    return [
      `${stopped} Workers stopped${stoppedNames ? `: ${stoppedNames}` : ""} · ${failures.length} failed · ${unfinished} unfinished Tasks retained`,
      ...(failures.length && currentNames ? [`Current members: ${currentNames}`] : []),
      state.taskAuthorityRetained === true ? "Task authority retained" : "",
    ].filter(Boolean);
  }
  return [];
}

/** Build the intentional human projection without serializing raw result data. */
export function formatPiTeamsToolResult(input: FormatPiTeamsToolResultInput): ToolResultRenderLine[] {
  const normalized = normalize(input);
  const outcome = input.isPartial ? "running" : normalized.outcome;
  const tone: LineTone = input.isError || normalized.outcome === "refused"
    ? "error"
    : input.isPartial || normalized.outcome === "partial" || normalized.warnings.length > 0
      ? "warning"
      : "success";
  const icon = tone === "error" ? "✗" : tone === "warning" ? "!" : "✓";
  const identity = receiptIdentity(input.tool, normalized, input.args);
  const state = input.tool.startsWith("task_") ? undefined : semanticState(input.tool, normalized.postState);
  const lines: ToolResultRenderLine[] = [{
    tone,
    text: `${icon} ${capitalize(outcome)}: ${identity}${state ? ` · ${state}` : ""}`,
  }];

  if (!input.isError) {
    for (const fact of compactFacts(input.tool, normalized)) {
      lines.push({ tone: "muted", text: `  ${fact}` });
    }
  }

  const suppressRedundantNotFound = !input.expanded
    && input.tool === "task_read"
    && isRecord(normalized.postState)
    && normalized.postState.found === false;
  const displayedWarnings = input.expanded
    ? normalized.warnings
    : suppressRedundantNotFound ? [] : normalized.warnings.slice(0, 2);
  for (const item of displayedWarnings) {
    const compactMissingAlertRecipient = !input.expanded
      && input.tool === "alert_send"
      && isRecord(normalized.postState)
      && normalized.postState.reason === "recipient_not_current"
      && item.code === "alert_recipient_not_current";
    const resourcePrefix = !compactMissingAlertRecipient && item.resourceId && item.resourceId !== normalized.resource?.id
      ? `${item.resourceId}: `
      : "";
    const message = compactMissingAlertRecipient
      ? "Recipient is not a current Team member."
      : item.message;
    lines.push({
      tone: normalized.outcome === "refused" ? "error" : "warning",
      text: `! ${resourcePrefix}${message}`,
    });
  }
  if (!input.expanded && normalized.warnings.length > displayedWarnings.length) {
    lines.push({ tone: "warning", text: `! ${normalized.warnings.length - displayedWarnings.length} more warning(s)` });
  }

  const modelLines = modelContentLines(input.content);
  if (modelLines.length > 0) {
    const modelCharacters = modelLines.join("\n").length;
    const showExactModelContent = input.expanded || (modelLines.length <= 2 && modelCharacters <= 240);
    lines.push({
      tone: "muted",
      text: showExactModelContent
        ? "Hints sent to agent:"
        : `Hints sent to agent: ${modelLines.length} ${modelLines.length === 1 ? "line" : "lines"} · ${modelCharacters} characters · expand for exact text`,
    });
    if (showExactModelContent) {
      for (const modelLine of modelLines) lines.push({ tone: "dim", text: modelLine, italic: true });
    }
  }

  if (input.expanded) {
    const sections: Array<[string, unknown]> = [
      ["Post-state", normalized.postState],
      ["Evidence", normalized.evidence],
      ["Diagnostics", normalized.diagnostics],
    ];
    for (const [label, value] of sections) {
      if (value === undefined) continue;
      lines.push({ tone: "muted", text: label });
      const humanValue = label === "Evidence" ? humanExpandedEvidence(input.tool, value) : value;
      for (const evidenceLine of structuredLines(humanValue)) {
        lines.push({ tone: "dim", text: `  ${evidenceLine}` });
      }
    }
    if (normalized.nextActions.length > 0) {
      lines.push({ tone: "accent", text: "Machine next actions (not sent to agent)" });
      for (const action of normalized.nextActions) {
        lines.push({ tone: "accent", text: `  ${action.tool} — ${action.reason}` });
        if (!action.args) continue;
        for (const argumentLine of structuredLines(action.args)) {
          lines.push({ tone: "dim", text: `    ${argumentLine}` });
        }
      }
    }
    if (normalized.legacy) {
      lines.push({ tone: "dim", text: "Legacy result adapted; versioned envelope unavailable." });
    }
  }

  return lines;
}

export type PiTeamsRenderResult = NonNullable<ToolDefinition["renderResult"]>;

/**
 * Integration: `renderResult: createPiTeamsResultRenderer("task_update")`.
 * Keep the standard Pi shell; this component intentionally owns only result
 * content and collapsed/expanded evidence projection.
 */
export function createPiTeamsResultRenderer(tool: PiTeamsPublicTool): PiTeamsRenderResult {
  return (result, options, theme, context) => {
    const lines = formatPiTeamsToolResult({
      tool,
      details: result.details,
      args: context.args,
      content: result.content,
      expanded: options.expanded,
      isPartial: options.isPartial,
      isError: context.isError,
    });
    const text = lines.map((line) => {
      const styled = theme.fg(line.tone, line.text);
      return line.italic ? theme.italic(styled) : styled;
    }).join("\n");
    return new Text(text, 0, 0);
  };
}
