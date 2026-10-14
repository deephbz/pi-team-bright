import type { WorldTrace } from "./trace-format";

/** Publish Worker and graph changes after the initial snapshot watermark. */
export function hydrationRaceTrace(gap = 1): WorldTrace {
  const who = { team: "team-1", actor: "lead" };
  return { version: 1, id: "snapshot-hydration-race", source: "synthetic", assumptions: [], setup: { ptbVersion: "v3.1", teams: [] }, steps: [
    { at: 0, step: { kind: "pi.start", who, session: "session-1", reason: "startup" } },
    { at: 0, step: { kind: "tool.call", who, tool: "team_create", args: { name: "team-1", purpose: "Synthetic hydration race" } } },
    { at: 0, step: { kind: "tool.call", who, tool: "team_sync", args: { view: "snapshot" } } },
    { at: gap, step: { kind: "tool.call", who, tool: "ensure_worker", args: { name: "w-race", scope: "Commit after the snapshot watermark" } } },
    { at: gap + 1, step: { kind: "tool.call", who, tool: "task_graph_apply", args: { operation_id: "race-task", tasks: [{ key: "race-task", title: "Race Task", goal: "Publish a graph revision after the snapshot watermark", assignee: "w-race" }] } } },
    { at: 500, step: { kind: "tool.call", who, tool: "team_sync", args: { view: "updates" } } },
  ] };
}
