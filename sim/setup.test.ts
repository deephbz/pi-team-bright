import { expect, it } from "vitest";
import { replayTrace } from "./replay";
import type { WorldTrace } from "./trace-format";

it("boots an assumed Team through durable authorities before observed inputs", async () => {
  const trace: WorldTrace = { version: 1, id: "existing-team", source: "synthetic", assumptions: [],
    setup: { ptbVersion: "v3.1", teams: [{ team: "team-1", workers: ["w1"] }] }, steps: [
      { at: 0, step: { kind: "tool.call", who: { team: "team-1", actor: "lead" }, tool: "team_sync", args: { view: "snapshot" } } },
      { at: 1, step: { kind: "tool.call", who: { team: "team-1", actor: "w1" }, tool: "alert_send", args: { kind: "attention", text: "Synthetic ready" } } },
    ] };
  const result = await replayTrace(trace, { seed: 42 });
  const sync = result.history.find(e => e.kind === "tool.result" && e.name === "team_sync");
  expect(sync?.kind === "tool.result" && sync.result.details).toMatchObject({ kind: "snapshot", team: { name: "team-1" }, workers: [{ name: "w1" }] });
  expect(result.actors.map(a => a.id)).toEqual(["team-1/lead", "team-1/w1"]);
  expect(result.history.filter(e => e.kind === "tool.result" && e.name === "ensure_worker").every(e => e.origin.kind === "setup")).toBe(true);
  expect(result.history.filter(e => e.kind === "world.input")).toHaveLength(2);
  const repeated = await replayTrace(trace, { receipt: result.receipt });
  expect(repeated.history).toEqual(result.history);
});

it("shows a created Task on the updates page independently of the P8 parser", async () => {
  const who = { team: "team-1", actor: "lead" };
  const result = await replayTrace({ version: 1, id: "task-page-shape", source: "synthetic", assumptions: [],
    setup: { ptbVersion: "v3.1", teams: [{ team: "team-1", workers: ["w1"] }] }, steps: [
      { at: 0, step: { kind: "tool.call", who, tool: "team_sync", args: { view: "snapshot" } } },
      { at: 0, step: { kind: "tool.call", who, tool: "task_graph_apply", args: { operation_id: "graph", tasks: [{ key: "work", title: "Synthetic work", goal: "Show the Task", assignee: "w1" }] } } },
      { at: 1, step: { kind: "tool.call", who, tool: "team_sync", args: { view: "updates" } } },
    ] }, { seed: 42 });
  const event = result.history.find(e => e.kind === "journal.append" && e.event.type === "task");
  const page = result.history.find(e => e.kind === "lead.entry" && e.stamp && (e.entry.message as any)?.details?.kind === "updates");
  expect(event?.kind).toBe("journal.append");
  expect(page?.kind).toBe("lead.entry");
  if (event?.kind !== "journal.append" || page?.kind !== "lead.entry") throw new Error("Missing Task evidence");
  const ref = event.event.raw.ref as { taskId: string; version: string };
  const message = page.entry.message as any;
  const payload = JSON.parse(message.content[0].text.slice(message.content[0].text.indexOf("\n") + 1));
  expect(payload.task_changes).toEqual(expect.arrayContaining([expect.objectContaining({ task_id: ref.taskId, current: expect.objectContaining({ id: ref.taskId, version: ref.version }) })]));
  expect(page.stamp!.through).toBeGreaterThanOrEqual(event.event.seq!);
});
