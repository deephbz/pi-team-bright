import type { WorldTrace } from "./trace-format";

/** Delay the external Task read while a real public Worker creation commits. */
export function hydrationRaceTrace(gap = 1): WorldTrace {
  const who = { team: "team-1", actor: "lead" };
  return { version: 1, id: "snapshot-hydration-race", source: "synthetic", assumptions: [], setup: { ptbVersion: "v3.1", teams: [] }, steps: [
    { at: 0, step: { kind: "pi.start", who, session: "session-1", reason: "startup" } },
    { at: 0, step: { kind: "tool.call", who, tool: "team_create", args: { name: "team-1", purpose: "Synthetic hydration race" } } },
    { at: 0, step: { kind: "fault.set", fault: { source: "bd", mode: "slow" } } },
    { at: 0, step: { kind: "tool.call", who, tool: "team_sync", args: { view: "snapshot" } } },
    { at: gap, step: { kind: "tool.call", who, tool: "ensure_worker", args: { name: "w-race", scope: "Commit during snapshot hydration" } } },
    { at: gap + 1, step: { kind: "fault.clear", source: "bd" } },
    { at: 500, step: { kind: "tool.call", who, tool: "team_sync", args: { view: "updates" } } },
  ] };
}
