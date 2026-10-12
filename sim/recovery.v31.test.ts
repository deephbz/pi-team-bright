import { expect, it } from "vitest";
import { replayTrace } from "./replay";
import type { WorldTrace } from "./trace-format";
import deadPi from "./fixtures/traces/bound-pi-dead.json";

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
  const messages = replay.history.filter(e => e.kind === "pi.message").map(e => e.value as any);
  expect(messages.filter(e => e.message.customType === "ptb.worker-recovery")).toHaveLength(1);
  expect(messages.find(e => e.message.customType === "ptb.worker-recovery").options.triggerTurn).toBe(true);
  const updates = replay.history.filter(e => e.kind === "tool.result" && (e.value as any).name === "task_update").map(e => (e.value as any).result.details);
  expect(updates.map(e => e.kind)).toEqual(["updated", "updated"]);
  expect(updates[1].task.current_attempt.id).toBe(updates[0].task.current_attempt.id);
  expect(updates[1].task.attempts_started).toBe(1);
  expect(replay.actors.find(actor => actor.id === "team-1/w1")?.branch.some((entry: any) => entry.type === "custom" && entry.customType.includes("ack"))).toBe(true);
}, 30000);
