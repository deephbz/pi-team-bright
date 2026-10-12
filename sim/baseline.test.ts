import { expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import startFailure from "./fixtures/traces/never-starts.json";
import piDead from "./fixtures/traces/bound-pi-dead.json";
import { replayTrace } from "./replay";
import type { WorldTrace } from "./trace-format";

function results(replay: Awaited<ReturnType<typeof replayTrace>>, name: string) {
  return replay.history.flatMap(event => event.kind === "tool.result" && event.name === name
    ? [{ at: event.at, details: event.result.details as any }] : []);
}

it("v3.1 scenario 1 returns within ten virtual seconds and keeps an ambiguous launch and pane", async () => {
  const started = performance.now();
  const replay = await replayTrace(startFailure as WorldTrace);
  console.info(`sim scenario 1: ${((performance.now() - started) * 1000 / replay.decisions.length).toFixed(2)} ms / 1000 operations (${replay.decisions.length} operations; includes module loading and real fs)`);
  const calls = results(replay, "ensure_worker");
  expect(results(replay, "team_create")[0]!.details.kind).toBe("team_created");
  expect(calls[0]!.at - replay.decisions[0]!.at).toBeLessThanOrEqual(10000);
  expect(calls[0]!.details).toMatchObject({ kind: "worker_ensured", effect: "created", launch: "requested" });
  expect(calls[1]!.details).toMatchObject({ kind: "attention", launchId: calls[0]!.details.launchId, nextActionHint: "wait" });
  expect(replay.panes.find(pane => pane.id === "pane-1")).toBeDefined();
  expect(replay.panes.filter(pane => pane.id.startsWith("pane-"))).toHaveLength(1);
}, 30000);

it("v3.1 scenario 2 never reuses dead Pi and replays real actor decisions exactly", async () => {
  const trace = piDead as WorldTrace;
  const started = performance.now();
  const first = await replayTrace(trace, { seed: 42 });
  console.info(`sim scenario 2: ${((performance.now() - started) * 1000 / first.decisions.length).toFixed(2)} ms / 1000 operations (${first.decisions.length} operations; includes module loading and real fs)`);
  const second = await replayTrace(trace, { receipt: first.receipt });
  expect(second).toEqual(first);
  expect(results(first, "team_create")[0]!.details.kind).toBe("team_created");
  const ensures = results(first, "ensure_worker");
  expect(ensures.some(call => call.details.effect === "reused")).toBe(false);
  expect(ensures.at(-1)!.details).toMatchObject({ kind: "worker_ensured", effect: "recovered", recoveryMode: "exact_session_resume" });
  const worker = first.processes.find(process => process.actor === "team-1/w1")!;
  expect(worker.alive).toBe(false);
  expect(first.panes.find(pane => pane.id === "pane-1")).toMatchObject({ agentPid: worker.pid, agentLive: false });
  expect(first.processes.find(process => process.pid === first.panes.find(pane => pane.id === "pane-1")!.shellPid)?.alive).toBe(true);
  expect(first.actors.find(actor => actor.id === "team-1/w1")).toBeDefined();
}, 30000);
