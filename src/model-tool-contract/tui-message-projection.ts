import { Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export type TuiMessageTone = "success" | "warning" | "error" | "info";
export type TuiMessageProvenance = "tool-result" | "task-delivery" | "direct-delivery" | "sync-nudge" | "gallery";

/** One audience projection shared by Pi renderers, tests, and the review gallery. */
export interface PiTeamBrightTuiMessage {
  type: string;
  tone: TuiMessageTone;
  lines: string[];
  detail: unknown;
  provenance: TuiMessageProvenance;
}

export interface ProjectionRenderOptions {
  expanded: boolean;
  includeHeader?: boolean;
  width?: number;
}

const toneRole = (tone: TuiMessageTone): "success" | "warning" | "error" | "customMessageText" => {
  if (tone === "success") return "success";
  if (tone === "warning") return "warning";
  if (tone === "error") return "error";
  return "customMessageText";
};

export function messageHeader(type: string): string {
  return `[pi-team-bright.${type}]`;
}

export function prettyDetail(detail: unknown): string {
  const encoded = JSON.stringify(detail ?? null, null, 2);
  return encoded ?? JSON.stringify(String(detail));
}

export function projectionLines(
  message: PiTeamBrightTuiMessage,
  options: ProjectionRenderOptions,
): string[] {
  const lines = [
    ...(options.includeHeader === false ? [] : [messageHeader(message.type)]),
    ...message.lines,
    ...(options.expanded ? ["details:", ...prettyDetail(message.detail).split("\n")] : []),
  ];
  if (!options.width) return lines;
  return lines.flatMap((line) => wrapTextWithAnsi(line, options.width!));
}

export function renderProjectionWithTheme(
  message: PiTeamBrightTuiMessage,
  options: ProjectionRenderOptions,
  theme: Theme,
): Text {
  const raw = projectionLines(message, { ...options, width: undefined });
  const headerIncluded = options.includeHeader !== false;
  const styled = raw.map((line, index) => {
    if (headerIncluded && index === 0) return theme.bold(theme.fg("customMessageLabel", line));
    const bodyIndex = index - (headerIncluded ? 1 : 0);
    if (bodyIndex === 0) return theme.fg(toneRole(message.tone), line);
    return theme.fg("customMessageText", line);
  });
  return new Text(styled.join("\n"), 0, 0);
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  success: "\u001b[32m",
  warning: "\u001b[33m",
  error: "\u001b[31m",
  info: "\u001b[36m",
  body: "\u001b[37m",
} as const;

/** Deterministic ANSI adapter for terminal review without a running Pi Session. */
export function projectionAnsi(
  message: PiTeamBrightTuiMessage,
  options: ProjectionRenderOptions,
): string[] {
  const headerIncluded = options.includeHeader !== false;
  const raw = projectionLines(message, { ...options, width: undefined });
  const tone = ANSI[message.tone];
  const styled = raw.map((line, index) => {
    if (headerIncluded && index === 0) return `${ANSI.bold}${ANSI.info}${line}${ANSI.reset}`;
    const bodyIndex = index - (headerIncluded ? 1 : 0);
    return `${bodyIndex === 0 ? tone : ANSI.body}${line}${ANSI.reset}`;
  });
  if (!options.width) return styled;
  return styled.flatMap((line) => wrapTextWithAnsi(line, options.width!));
}
