import { expect, it } from "vitest";
import { replayTrace } from "./replay";
import { hydrationRaceTrace } from "./hydration-race";

// Full-suite CPU contention reached 4002 ms; 15 s gives both deterministic replays headroom.
it("reconciles graph authority writes made after a snapshot watermark", async () => {
  const result = await replayTrace(hydrationRaceTrace(), { seed: 42 });
  const calls = result.history.filter(e => e.kind === "tool.call");
  const snapshotCall = calls.find(e => e.name === "team_sync")!;
  const snapshotResult = result.history.find(e => e.kind === "tool.result" && e.callId === snapshotCall.callId)!;
  const graphCall = calls.find(e => e.name === "task_graph_apply")!;
  const graphResult = result.history.find(e => e.kind === "tool.result" && e.callId === graphCall.callId)!;
  expect(snapshotResult.sequence).toBeLessThan(graphCall.sequence);
  expect(graphResult.kind === "tool.result" && graphResult.result.details).toMatchObject({ kind: "task_graph_applied" });
  expect(result.history.some(e => e.kind === "durable.record" && e.path.includes("/task-authority/"))).toBe(true);
  const syncResults = result.history.filter(e => e.kind === "tool.result").filter(e => e.name === "team_sync");
  expect(syncResults[0]!.result.details).toMatchObject({ kind: "snapshot", workers: [], observation: { through: 0 } });
  expect(syncResults[1]!.result.details).toMatchObject({ kind: "updates", worker_changes: expect.arrayContaining([expect.objectContaining({ worker: "w-race" })]) });
  const repeated = await replayTrace(hydrationRaceTrace(), { receipt: result.receipt });
  expect(repeated.history).toEqual(result.history);
}, 15000);
