import type { ObservationStamp } from "./branch-observation";

/** Shared model framing for native tool results and framework messages. */
export function observationPageLine(kind: string, stamp: ObservationStamp): string {
  const first = stamp.through > stamp.from ? stamp.from + 1 : stamp.from;
  const action = kind === "snapshot" ? "Review current Team state, then end your turn to wait."
    : kind === "updates" ? "Handle the changes, then end your turn to wait."
    : "End your turn to wait for Team updates.";
  return `team_sync ${kind}, events ${first}-${stamp.through}. ${action}`;
}

export function parseObservationContent(content: string): any {
  const framed = content.startsWith("ptb.team-update: ") || content.startsWith("team_sync ");
  return JSON.parse(framed ? content.slice(content.indexOf("\n") + 1) : content);
}
