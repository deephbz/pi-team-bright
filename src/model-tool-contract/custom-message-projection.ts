import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { projectionLines, renderProjectionWithTheme, type PiTeamBrightTuiMessage } from "./tui-message-projection";
import { syncNudgeTuiLine, validateSyncNudgeRecord } from "../utils/sync-nudge";

interface PiCustomMessage {
  content?: unknown;
  details?: unknown;
}

interface MessageRenderOptions {
  expanded: boolean;
  outputPad?: number;
}

export type CustomMessageRenderer = (
  message: PiCustomMessage,
  options?: MessageRenderOptions,
  theme?: Theme,
) => ReturnType<typeof renderProjectionWithTheme> | undefined;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content
    .filter((part) => part && typeof part === "object" && (part as any).type === "text")
    .map((part) => String((part as any).text ?? ""))
    .join("\n");
  return "";
}

/** Parse the controlled final JSON value while ignoring historical prose headings. */
export function parseCustomMessageDetail(content: unknown): unknown {
  const text = contentText(content);
  let candidates = 0;
  for (const match of text.matchAll(/^[ \t]*[{[]/gm)) {
    if (++candidates > 32) break;
    try { return JSON.parse(text.slice(match.index).trim()); } catch { /* Historical headings can begin with '['. */ }
  }
  throw new Error("Custom message has no valid JSON payload.");
}

const compact = (value: unknown, limit = 120): string => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
};

export function projectTaskChangeMessage(message: PiCustomMessage): PiTeamBrightTuiMessage {
  try {
    const detail = parseCustomMessageDetail(message.content) as any;
    if (!detail || !Array.isArray(detail.changes)) throw new Error("Task change payload is invalid.");
    const changes: string[] = [];
    for (const change of detail.changes) {
      const task = change?.task;
      if (!task || typeof task.id !== "string") continue;
      const assignee = task.assignee || "unassigned";
      changes.push(`[${task.status ?? "unknown"}] ${task.id}@${assignee} · ${compact(task.title)}`);
    }
    return {
      type: "task-change", tone: "info", status: "Task change received",
      summary: `${detail.changes.length} Task change${detail.changes.length === 1 ? "" : "s"} delivered.`,
      body: changes.slice(0, 6),
      expandedLines: changes.length > 6 ? ["All Task changes:", ...changes.slice(6)] : undefined,
      detail, provenance: "task-delivery",
    };
  } catch (error) {
    return {
      type: "task-change",
      tone: "error",
      status: "presentation error",
      summary: "Task change presentation payload is malformed.",
      body: ["Expand to inspect the raw report."],
      detail: { issue: error instanceof Error ? error.message : String(error), content: message.content, delivery: message.details },
      provenance: "task-delivery",
    };
  }
}

export function projectDirectMessage(message: PiCustomMessage): PiTeamBrightTuiMessage {
  try {
    const detail = parseCustomMessageDetail(message.content) as any;
    if (!detail || !Array.isArray(detail.messages)) throw new Error("Direct message payload is invalid.");
    const items = detail.messages as any[];
    const preview = (item: any): string => `${compact(item?.from || "unknown")}: ${compact(item?.summary || item?.content || "(no content)")}`;
    const full = (item: any): string => `From ${compact(item?.from || "unknown")} — ${String(item?.content || item?.summary || "(no content)")}`;
    const single = items.length === 1;
    return {
      type: "direct-message", tone: "info", status: single ? "Alert received" : `${items.length} Alerts received`,
      source: single ? `From ${compact(items[0]?.from || "unknown")}` : undefined,
      summary: single ? compact(items[0]?.summary || items[0]?.content || "(no content)") : `${items.length} Alerts delivered.`,
      body: single ? [] : items.slice(0, 6).map(preview),
      expandedLines: ["Full Alert content:", ...items.map(full)],
      detail, provenance: "direct-delivery",
    };
  } catch (error) {
    return {
      type: "direct-message",
      tone: "error",
      status: "presentation error",
      summary: "Alert presentation payload is malformed.",
      body: ["Expand to inspect the raw report."],
      detail: { issue: error instanceof Error ? error.message : String(error), content: message.content, delivery: message.details },
      provenance: "direct-delivery",
    };
  }
}

/**
 * Project the /ptb doctor follow-up into a compact transcript item.
 *
 * The complete guide and sampled metadata remain in `content` for the model.
 * The TUI keeps that payload behind Pi's normal expansion affordance so a
 * repair guide does not push the active conversation off screen.
 */
export function projectDoctorMessage(message: PiCustomMessage): PiTeamBrightTuiMessage {
  const content = contentText(message.content).trim();
  if (!content) {
    return {
      type: "doctor",
      tone: "error",
      status: "presentation error",
      summary: "Team doctor context is empty.",
      body: ["Run /ptb doctor again to collect a fresh guide and metadata sample."],
      detail: { issue: "empty_content", content: message.content, details: message.details },
      provenance: "doctor",
    };
  }
  const marker = "Invocation metadata (observations, not authority):";
  const metadataIndex = content.indexOf(marker);
  const metadataSummary = metadataIndex >= 0 ? "Guide and sampled Team metadata" : "Repair guide";
  return {
    type: "doctor",
    tone: "info",
    status: "Team doctor context ready",
    summary: `${metadataSummary} sent to the model.`,
    body: [],
    detail: { content, details: message.details },
    expandedLines: ["", "Agent context:", ...content.split("\n")],
    provenance: "doctor",
  };
}

export function projectSyncNudgeMessage(message: PiCustomMessage): PiTeamBrightTuiMessage | undefined {
  const record = validateSyncNudgeRecord(message.details);
  if (!record) return undefined;
  return {
    type: "sync-nudge",
    tone: "warning",
    status: "Team sync needed",
    summary: syncNudgeTuiLine(record),
    detail: record,
    provenance: "sync-nudge",
  };
}

export function createCustomMessageRenderer(
  projector: (message: PiCustomMessage) => PiTeamBrightTuiMessage | undefined,
): CustomMessageRenderer {
  return (message, options, theme) => {
    const projection = projector(message);
    if (!projection) return undefined;
    const expanded = options?.expanded ?? false;
    return theme
      ? renderProjectionWithTheme(projection, { expanded }, theme)
      : new Text(projectionLines(projection, { expanded }).join("\n"), 0, 0);
  };
}
