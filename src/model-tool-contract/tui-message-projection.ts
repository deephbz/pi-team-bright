import { Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createTuiReviewTheme } from "./tui-review-theme";

export type TuiMessageTone = "success" | "warning" | "error" | "info";
export type TuiMessageProvenance = "tool-result" | "task-delivery" | "direct-delivery" | "sync-nudge" | "doctor" | "gallery";

/** Owns transcript presentation only. Domain results and delivery records remain authoritative. */
export interface PiTeamBrightTuiMessage {
  type: string;
  tone: TuiMessageTone;
  status: string;
  summary: string;
  source?: string;
  body?: string[];
  detail: unknown;
  /** Full human-readable content appears before diagnostic JSON when expanded. */
  expandedLines?: string[];
  provenance: TuiMessageProvenance;
}

export interface ProjectionRenderOptions {
  expanded: boolean;
  includeHeader?: boolean;
  width?: number;
}

type LineRole = "header" | "status" | "body" | "hint";
type ProjectedLine = { text: string; role: LineRole };

const toneRole = (tone: TuiMessageTone): "success" | "warning" | "error" | "customMessageText" => {
  if (tone === "success") return "success";
  if (tone === "warning") return "warning";
  if (tone === "error") return "error";
  return "customMessageText";
};

export function messageHeader(type: string): string {
  const names: Record<string, string> = {
    team_create: "Team", ensure_worker: "Worker", task_graph_apply: "Task graph", task_create: "Task graph",
    task_read: "Task read", task_update: "Task update", team_sync: "Team sync", task_link: "Task link",
    alert_send: "Alert", worker_stop: "Worker stop", team_shutdown: "Team shutdown",
    "task-change": "Task change", "direct-message": "Alert", "sync-nudge": "Team sync", doctor: "Doctor",
  };
  return `PTB · ${names[type] ?? type.replace(/[-_]/g, " ")}`;
}

export function prettyDetail(detail: unknown): string {
  try {
    return JSON.stringify(detail ?? null, null, 2) ?? JSON.stringify(String(detail));
  } catch {
    return JSON.stringify("Diagnostic value could not be serialized.");
  }
}

const statusMark = (tone: TuiMessageTone): string => {
  if (tone === "success") return "✓";
  if (tone === "warning") return "!";
  if (tone === "error") return "✗";
  return "•";
};

/** Display text may contain agent-supplied control bytes; JSON detail stays intact. */
function safeText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function projectedLines(message: PiTeamBrightTuiMessage, options: ProjectionRenderOptions): ProjectedLine[] {
  const lines: ProjectedLine[] = [];
  if (options.includeHeader !== false) lines.push({ text: safeText(`${messageHeader(message.type)}${message.source ? ` · ${message.source}` : ""}`), role: "header" });
  if (message.status) lines.push({ text: safeText(`${statusMark(message.tone)} ${message.status}`), role: "status" });
  if (message.summary) lines.push({ text: safeText(message.summary), role: "body" });
  for (const line of message.body ?? []) lines.push({ text: safeText(line), role: "body" });
  if (!options.expanded && (message.detail != null || (message.expandedLines?.length ?? 0) > 0)) {
    lines.push({ text: "▸ Details", role: "hint" });
  }
  if (options.expanded) {
    for (const line of message.expandedLines ?? []) lines.push({ text: safeText(line), role: "body" });
    lines.push({ text: "details:", role: "body" });
    for (const line of prettyDetail(message.detail).split("\n")) lines.push({ text: line, role: "body" });
  }
  return lines;
}

export function projectionLines(
  message: PiTeamBrightTuiMessage,
  options: ProjectionRenderOptions,
): string[] {
  const lines = projectedLines(message, options).map((line) => line.text);
  if (!options.width) return lines;
  return lines.flatMap((line) => wrapTextWithAnsi(line, options.width!));
}

export function renderProjectionWithTheme(
  message: PiTeamBrightTuiMessage,
  options: ProjectionRenderOptions,
  theme: Theme,
): Text {
  const styled = projectedLines(message, options).map(({ text, role }) => {
    if (role === "header") return theme.bold(theme.fg("customMessageLabel", text));
    if (role === "status") return theme.fg(toneRole(message.tone), text);
    if (role === "hint") return theme.fg("dim", text);
    return theme.fg("customMessageText", text);
  });
  return new Text(styled.join("\n"), 1, 0, (text) => theme.bg("customMessageBg", text));
}

/** Deterministic terminal adapter that exercises the production themed renderer. */
export function projectionAnsi(
  message: PiTeamBrightTuiMessage,
  options: ProjectionRenderOptions,
): string[] {
  const width = options.width ?? Math.max(4, ...projectionLines(message, { ...options, width: undefined }).map((line) => visibleWidth(line) + 2));
  return renderProjectionWithTheme(message, { ...options, width: undefined }, createTuiReviewTheme("dark")).render(width);
}
