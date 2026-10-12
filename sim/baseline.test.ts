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

it("baseline scenario 1 waits 300 virtual seconds, cleans its carrier, then starts a real Worker on retry", async () => {
  const started = performance.now();
  const replay = await replayTrace(startFailure as WorldTrace);
  console.info(`sim scenario 1: ${((performance.now() - started) * 1000 / replay.decisions.length).toFixed(2)} ms / 1000 operations (${replay.decisions.length} operations; includes module loading and real fs)`);
  const calls = results(replay, "ensure_worker");
  expect(results(replay, "team_create")[0]!.details.kind).toBe("team_created");
  expect(calls[0]!.at - replay.decisions[0]!.at).toBe(300000);
  expect(calls[0]!.details).toMatchObject({ kind: "unavailable", reason: "carrier_unavailable" });
  expect(calls[0]!.details.message).toContain("confirmed carrier cleanup");
  expect(calls[1]!.details).toMatchObject({ kind: "worker_ensured", effect: "created", worker: { carrier: "connected" } });
  expect(replay.actors.find(actor => actor.id === "team-1/w1")?.tools.sort()).toEqual(["alert_send", "task_read", "task_update"]);
  expect(replay.panes.find(pane => pane.id === "pane-1")).toBeUndefined();
}, 30000);

it("baseline scenario 2 reproduces dead-Pi reuse and replays real actor decisions and enabled operations exactly", async () => {
  const trace = piDead as WorldTrace;
  const started = performance.now();
  const first = await replayTrace(trace, { seed: 42 });
  console.info(`sim scenario 2: ${((performance.now() - started) * 1000 / first.decisions.length).toFixed(2)} ms / 1000 operations (${first.decisions.length} operations; includes module loading and real fs)`);
  const second = await replayTrace(trace, { receipt: first.receipt });
  expect(second).toEqual(first);
  expect(results(first, "team_create")[0]!.details.kind).toBe("team_created");
  expect(results(first, "ensure_worker").find(call => call.details.effect === "reused")?.details.worker.carrier).toBe("connected");
  const worker = first.processes.findLast(process => process.actor === "team-1/w1")!;
  expect(worker.alive).toBe(false);
  expect(first.panes.find(pane => pane.id === "pane-1")).toMatchObject({ agentPid: worker.pid, agentLive: false });
  expect(first.processes.find(process => process.pid === first.panes.find(pane => pane.id === "pane-1")!.shellPid)?.alive).toBe(true);
  expect(first.actors.find(actor => actor.id === "team-1/w1")).toBeDefined();
}, 30000);
