import type { TSchema } from "typebox";
import { ModelResultSchemas, type ProjectedTool } from "./result-projection";
import { projectModelToolTuiMessage, projectToolTuiMessage } from "./tui-projection";
import { projectionAnsi, projectionLines, type PiTeamBrightTuiMessage } from "./tui-message-projection";
import { projectDirectMessage, projectSyncNudgeMessage, projectTaskChangeMessage } from "./custom-message-projection";
import { createSyncNudgeRecord } from "../utils/sync-nudge";

export const DISPLAYED_TOOL_TYPES = [
  "team_create",
  "ensure_worker",
  "task_graph_apply",
  "task_read",
  "task_update",
  "team_sync",
  "worker_stop",
  "team_shutdown",
  "alert_send",
] as const satisfies readonly ProjectedTool[];

export interface TuiMessageGalleryScenario {
  id: string;
  title: string;
  source: "tool" | "custom" | "diagnostic";
  resultKind?: string;
  message: PiTeamBrightTuiMessage;
}

export type TuiMessageGalleryFormat = "plain" | "ansi" | "json";

function kindValues(schema: any): string[] {
  if (typeof schema?.const === "string") return [schema.const];
  if (Array.isArray(schema?.enum)) return schema.enum.filter((value: unknown): value is string => typeof value === "string");
  if (Array.isArray(schema?.anyOf)) return schema.anyOf.flatMap(kindValues);
  return [];
}

/** Return every top-level discriminant, including nested ModelFailure unions. */
export function modelResultKinds(schema: TSchema): string[] {
  const variants: any[] = (schema as any).anyOf ?? [schema];
  const kinds: string[] = variants.flatMap((variant: any) => kindValues(variant.properties?.kind));
  return [...new Set<string>(kinds)];
}

function sampleString(schema: any): string {
  if (schema.pattern === "^v_[0-9a-f]{16}$") return "v_0123456789abcdef";
  if (schema.pattern === "^g_[0-9a-f]{16}$") return "g_0123456789abcdef";
  if (schema.pattern === "^[A-Za-z0-9_-]+$") return "sample";
  return "x".repeat(Math.max(1, schema.minLength ?? 1));
}

function sampleValue(schema: any): any {
  if (!schema || typeof schema !== "object") return null;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.anyOf)) return sampleValue(schema.anyOf[0]);
  if (schema.type === "object" || schema.properties || schema.patternProperties) {
    if (schema.patternProperties && !schema.properties) return {};
    const required = new Set<string>(schema.required ?? Object.keys(schema.properties ?? {}));
    return Object.fromEntries(Object.entries(schema.properties ?? {})
      .filter(([key]) => required.has(key))
      .map(([key, value]) => [key, sampleValue(value)]));
  }
  if (schema.type === "array") return [];
  if (schema.type === "string") return sampleString(schema);
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "null") return null;
  return null;
}

function toolScenarios(): TuiMessageGalleryScenario[] {
  const scenarios: TuiMessageGalleryScenario[] = [];
  for (const tool of DISPLAYED_TOOL_TYPES) {
    const schema = ModelResultSchemas[tool] as any;
    const variants = schema.anyOf ?? [schema];
    const seen = new Map<string, number>();
    for (const variant of variants) {
      const base = sampleValue(variant);
      for (const kind of kindValues(variant.properties?.kind)) {
        const ordinal = (seen.get(kind) ?? 0) + 1;
        seen.set(kind, ordinal);
        const model = { ...base, kind };
        scenarios.push({
          id: `${tool}.${kind}${ordinal > 1 ? `-${ordinal}` : ""}`,
          title: `${tool}: ${kind}${ordinal > 1 ? ` variant ${ordinal}` : ""}`,
          source: "tool",
          resultKind: kind,
          message: projectModelToolTuiMessage(tool, model, model),
        });
      }
    }
  }

  const graphApplied = scenarios.find((item) => item.id === "task_graph_apply.task_graph_applied")!;
  scenarios.push({
    id: "task_graph_apply.replayed",
    title: "task_graph_apply: successful replay",
    source: "tool",
    resultKind: "task_graph_applied",
    message: projectModelToolTuiMessage("task_graph_apply", { ...graphApplied.message.detail as any, replayed: true }, { ...graphApplied.message.detail as any, replayed: true }),
  });
  scenarios.push({
    id: "alert_send.partial",
    title: "alert_send: partial recipient delivery",
    source: "tool",
    resultKind: "alert_sent",
    message: projectModelToolTuiMessage("alert_send", { kind: "alert_sent", accepted_recipients: ["reviewer"], failed_recipients: ["offline"] }),
  });
  scenarios.push({
    id: "task_update.version-conflict",
    title: "task_update: version conflict with recovery",
    source: "tool",
    resultKind: "refused",
    message: projectModelToolTuiMessage("task_update", {
      kind: "refused",
      task_id: "verify",
      operation_id: "claim-2",
      reason: "version_conflict",
      message: "The supplied Task version is stale.",
      recovery: { action: "reconcile_and_retry", expected_version: "v_0123456789abcdef" },
    }),
  });
  scenarios.push({
    id: "task_graph_apply.delivery-warning",
    title: "task_graph_apply: committed with delivery warning",
    source: "tool",
    resultKind: "task_graph_applied",
    message: projectModelToolTuiMessage("task_graph_apply", {
      ...graphApplied.message.detail as any,
      delivery_warnings: ["Worker delivery will retry."],
    }),
  });
  return scenarios;
}

function customScenarios(): TuiMessageGalleryScenario[] {
  const taskContent = [
    "These changes were already accepted by Task authority.",
    JSON.stringify({ changes: [{ task: {
      id: "verify-release",
      title: "Verify release candidate",
      status: "in_progress",
      assignee: "reviewer",
      version: "v_0123456789abcdef",
      goal: "Verify the exact candidate.",
      current_context: "Verification is active.",
    } }] }, null, 2),
  ].join("\n");
  const directContent = [
    "These accepted coordination records were delivered to this exact Session.",
    JSON.stringify({ messages: [{
      id: "alert-1",
      from: "team-lead",
      sentAt: "2026-08-14T12:00:00.000Z",
      summary: "Check the exact release digest.",
      content: "Compare the package and provenance digests.",
    }] }, null, 2),
  ].join("\n");
  const nudge = createSyncNudgeRecord({
    id: "nudge-1",
    kind: "presented",
    teamName: "release-team",
    teamEpochId: "epoch-1",
    leaderSessionId: "session-1",
    leaderMembershipId: "membership-1",
    branchLineage: ["root"],
    branchId: "root",
    debtKey: "worker-authored-change",
    requestedView: "updates",
    reservedAt: "2026-08-14T12:00:00.000Z",
    presentedAt: "2026-08-14T12:00:01.000Z",
    policyVersion: "1",
  });
  return [
    { id: "custom.task-change", title: "Task assignment delivery", source: "custom", message: projectTaskChangeMessage({ content: taskContent, details: { deliveryIds: ["delivery-1"] } }) },
    { id: "custom.direct-message", title: "Direct coordination delivery", source: "custom", message: projectDirectMessage({ content: directContent, details: { messageIds: ["alert-1"] } }) },
    { id: "custom.sync-nudge", title: "Team synchronization nudge", source: "custom", message: projectSyncNudgeMessage({ details: nudge })! },
    { id: "custom.task-change-malformed", title: "Malformed Task delivery projection", source: "diagnostic", message: projectTaskChangeMessage({ content: "not JSON", details: { deliveryIds: ["delivery-bad"] } }) },
    { id: "custom.direct-message-malformed", title: "Malformed coordination projection", source: "diagnostic", message: projectDirectMessage({ content: "not JSON", details: { messageIds: ["alert-bad"] } }) },
  ];
}

function diagnosticScenarios(): TuiMessageGalleryScenario[] {
  return [
    {
      id: "diagnostic.execution-error",
      title: "Tool execution error",
      source: "diagnostic",
      message: projectToolTuiMessage({ tool: "task_update", content: [{ type: "text", text: "Execution failed." }], details: { operation_id: "op-1" }, expanded: false, isError: true }),
    },
    {
      id: "diagnostic.projection-error",
      title: "Tool result projection error",
      source: "diagnostic",
      message: projectToolTuiMessage({ tool: "task_read", content: [{ type: "text", text: "Malformed result." }], details: { malformed: true }, expanded: false }),
    },
  ];
}

export function tuiMessageGallery(): TuiMessageGalleryScenario[] {
  return [...toolScenarios(), ...customScenarios(), ...diagnosticScenarios()];
}

export function exportTuiMessageGallery(options: {
  format: TuiMessageGalleryFormat;
  expanded: boolean;
  width?: number;
}): string {
  const scenarios = tuiMessageGallery();
  if (options.format === "json") return `${JSON.stringify({
    schema: "pi-team-bright/tui-message-gallery/1",
    expanded: options.expanded,
    style: { header: { bold: true, role: "customMessageLabel" }, body: { role: "customMessageText", toneRole: true } },
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      source: scenario.source,
      resultKind: scenario.resultKind,
      projection: scenario.message,
      lines: projectionLines(scenario.message, { expanded: options.expanded, width: options.width }),
    })),
  }, null, 2)}\n`;
  return `${scenarios.map((scenario) => {
    const lines = options.format === "ansi"
      ? projectionAnsi(scenario.message, { expanded: options.expanded, width: options.width })
      : projectionLines(scenario.message, { expanded: options.expanded, width: options.width });
    return `=== ${scenario.id} — ${scenario.title} ===\n${lines.join("\n")}`;
  }).join("\n\n")}\n`;
}
