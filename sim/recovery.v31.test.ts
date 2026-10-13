import { expect, it } from "vitest";
import { replayTrace } from "./replay";
import type { WorldTrace } from "./trace-format";
import deadPi from "./fixtures/traces/bound-pi-dead.json";

it("recovers an exact Session after all registered Worker panes close", async () => {
  const trace: WorldTrace = {
    version: 1, id: "all-worker-panes-closed", source: "synthetic",
    assumptions: ["A2", "S-first-worker-pane-is-pane-1"],
    setup: { ptbVersion: "v3.1", teams: [{ team: "team-1", workers: ["w1", "w2"] }] },
    steps: [
      { at: 0, step: { kind: "human.closePane", pane: "pane-1" } },
      { at: 1, step: { kind: "human.closePane", pane: "pane-2" } },
      { at: 2, step: { kind: "tool.call", who: { team: "team-1", actor: "lead" }, tool: "ensure_worker", args: { name: "w1", scope: "Recover closed Worker" } } },
    ],
  };
  const replay = await replayTrace(trace, { seed: 42 });
  const ensured = replay.history.filter(e => e.kind === "tool.result" && e.name === "ensure_worker").at(-1);
  expect(ensured).toMatchObject({ result: { details: { kind: "worker_ensured", effect: "recovered", recoveryMode: "exact_session_resume" } } });
  expect(replay.panes.some(pane => pane.id === "pane-1" || pane.id === "pane-2")).toBe(false);
  expect(replay.panes.find(pane => pane.id === "pane-3")).toMatchObject({ agentLive: true });
  const generations = replay.actors.filter(actor => actor.id === "team-1/w1");
  expect(generations).toHaveLength(2);
  expect(generations[1]).toMatchObject({ alive: true, sessionId: generations[0]!.sessionId });
  expect(generations[1]!.generation).not.toEqual(generations[0]!.generation);
}, 30000);

// Full-suite CPU contention reached 4524 ms; retain 30 s for durable Task recovery.
it("wakes an exact recovered Session for its ACKed in-progress Task without a new Attempt", async () => {
  const lead = { team: "team-1", actor: "lead" };
  const worker = { team: "team-1", actor: "w1" };
  const ref = ($fromStep: number, path: string) => ({ $fromStep, path });
  const trace: WorldTrace = { ...structuredClone(deadPi) as WorldTrace, id: "acked-task-recovery", steps: [
    ...(deadPi as WorldTrace).steps.slice(0, 4),
    { at: 2, step: { kind: "tool.call", who: lead, tool: "task_graph_apply", args: { operation_id: "graph", tasks: [{ key: "work", title: "Recover work", goal: "Continue the exact Attempt", assignee: "w1" }] } } },
    { at: 500, step: { kind: "turn.end", who: worker, outcome: "settled" } },
    { at: 1000, step: { kind: "tool.call", who: worker, tool: "task_update", args: { task_id: ref(4, "details.tasks_by_key.work.id"), operation_id: "claim", expected_version: ref(4, "details.tasks_by_key.work.version"), transition: "claim" } } },
    { at: 1200, step: { kind: "turn.end", who: worker, outcome: "settled" } },
    { at: 2000, step: { kind: "os.kill", who: worker, signal: "SIGKILL" } },
    { at: 2001, step: { kind: "tool.call", who: lead, tool: "ensure_worker", args: { name: "w1", scope: "text-1" } } },
    { at: 2002, step: { kind: "tool.call", who: worker, tool: "task_update", args: { task_id: ref(4, "details.tasks_by_key.work.id"), operation_id: "after-recovery", expected_version: ref(6, "details.task.version"), current_context: "Resumed the same Attempt after recovery" } } },
    { at: 3000, step: { kind: "pi.shutdown", who: worker, reason: "quit" } },
    { at: 3001, step: { kind: "pi.shutdown", who: lead, reason: "quit" } },
  ] };
  const replay = await replayTrace(trace, { seed: 42 });
  const messages = replay.history.filter(e => e.kind === "pi.message");
  expect(messages.filter(e => e.message.customType === "ptb.worker-recovery")).toHaveLength(1);
  expect(messages.find(e => e.message.customType === "ptb.worker-recovery")?.options?.triggerTurn).toBe(true);
  const updates = replay.history.filter(e => e.kind === "tool.result").filter(e => e.name === "task_update").map(e => e.result.details as any);
  expect(updates.map(e => e.kind)).toEqual(["updated", "updated"]);
  expect(updates[1].task.current_attempt.id).toBe(updates[0].task.current_attempt.id);
  expect(updates[1].task.attempts_started).toBe(1);
  expect(replay.actors.find(actor => actor.id === "team-1/w1")?.branch.some((entry: any) => entry.type === "custom" && entry.customType.includes("ack"))).toBe(true);
}, 30000);
