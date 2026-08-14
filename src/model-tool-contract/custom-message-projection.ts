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
  const start = text.search(/^[{[]/m);
  if (start < 0) throw new Error("Custom message has no JSON payload.");
  return JSON.parse(text.slice(start));
}

const compact = (value: unknown, limit = 120): string => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
};

export function projectTaskChangeMessage(message: PiCustomMessage): PiTeamBrightTuiMessage {
  try {
    const detail = parseCustomMessageDetail(message.content) as any;
    if (!detail || !Array.isArray(detail.changes)) throw new Error("Task change payload is invalid.");
    const lines = [`${detail.changes.length} Task change${detail.changes.length === 1 ? "" : "s"} delivered.`];
    for (const change of detail.changes.slice(0, 6)) {
      const task = change?.task;
      if (!task || typeof task.id !== "string") continue;
      const assignee = task.assignee || "unassigned";
      lines.push(`[${task.status ?? "unknown"}] ${task.id}@${assignee} · ${compact(task.title)}`);
    }
    if (detail.changes.length > 6) lines.push(`… ${detail.changes.length - 6} more; press Ctrl+O for JSON.`);
    return { type: "task-change", tone: "info", lines, detail, provenance: "task-delivery" };
  } catch (error) {
    return {
      type: "task-change",
      tone: "error",
      lines: ["✗ Task change presentation payload is malformed.", "  Press Ctrl+O to inspect the raw report."],
      detail: { issue: error instanceof Error ? error.message : String(error), content: message.content, delivery: message.details },
      provenance: "task-delivery",
    };
  }
}

export function projectDirectMessage(message: PiCustomMessage): PiTeamBrightTuiMessage {
  try {
    const detail = parseCustomMessageDetail(message.content) as any;
    if (!detail || !Array.isArray(detail.messages)) throw new Error("Direct message payload is invalid.");
    const lines = [`${detail.messages.length} coordination message${detail.messages.length === 1 ? "" : "s"} delivered.`];
    for (const item of detail.messages.slice(0, 6)) {
      lines.push(`From ${compact(item?.from || "unknown")}: ${compact(item?.summary || item?.content || "(no content)")}`);
    }
    if (detail.messages.length > 6) lines.push(`… ${detail.messages.length - 6} more; press Ctrl+O for JSON.`);
    return { type: "direct-message", tone: "info", lines, detail, provenance: "direct-delivery" };
  } catch (error) {
    return {
      type: "direct-message",
      tone: "error",
      lines: ["✗ Coordination message presentation payload is malformed.", "  Press Ctrl+O to inspect the raw report."],
      detail: { issue: error instanceof Error ? error.message : String(error), content: message.content, delivery: message.details },
      provenance: "direct-delivery",
    };
  }
}

export function projectSyncNudgeMessage(message: PiCustomMessage): PiTeamBrightTuiMessage | undefined {
  const record = validateSyncNudgeRecord(message.details);
  if (!record) return undefined;
  return {
    type: "sync-nudge",
    tone: "warning",
    lines: [syncNudgeTuiLine(record)],
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
