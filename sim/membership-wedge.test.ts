import fs from "node:fs";
import { expect, it } from "vitest";
import { replayTrace } from "./replay";
import { WEDGE_FILLED as FILLED, wedgeTrace } from "./membership-wedge-trace";

/**
 * Replays the 2026-10-16 wedge in the world: pane geometry runs out and spawns
 * are refused. Each later refusal must name its own cause, and every refused
 * Worker must stop without manual repair. The fake Herdr does not reflow a
 * closed pane, so geometry stays full after a stop. Set PTB_SIM_WEDGE_SUMMARY to a path to
 * record the outcome table before the assertions run.
 */
it("leaves no unstoppable residue after geometry refusals", async () => {
  const replay = await replayTrace(wedgeTrace(), { seed: 42 });

  const results = replay.history.filter(e => e.kind === "tool.result").map(e => (e as any).result.details as Record<string, any>);
  const outcome = (i: number) => { const d = results[i]!; return d.kind === "worker_ensured" ? `${d.kind}:${d.effect}` : `${d.kind}:${d.reason ?? ""}`; };
  const team = replay.history.filter(e => e.kind === "durable.team" && e.record).at(-1) as any;
  const active = (team.record.members as any[]).filter(m => m.agentType === "teammate" && m.isActive !== false);
  const summary = {
    refusals: [outcome(FILLED + 1), outcome(FILLED + 2)],
    stopFilled: outcome(FILLED + 3),
    afterStop: outcome(FILLED + 4),
    afterStopMessage: results[FILLED + 4]!.message,
    stopRefused: [outcome(FILLED + 5), outcome(FILLED + 6), outcome(FILLED + 7)],
    residue: active.filter(m => !m.sessionFile && !m.terminalTarget).map(m => `${m.name}:${m.launch?.state ?? "no_launch"}`),
    liveAgents: replay.panes.filter(p => p.agentLive).length,
  };
  if (process.env.PTB_SIM_WEDGE_SUMMARY) fs.writeFileSync(process.env.PTB_SIM_WEDGE_SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);

  expect(summary.refusals).toEqual(["unavailable:carrier_unavailable", "unavailable:carrier_unavailable"]);
  expect(summary.stopFilled).toBe("worker_stopped:");
  expect(summary.afterStop).toBe("unavailable:carrier_unavailable");
  expect(summary.afterStopMessage).toMatch(/^Insufficient Herdr pane geometry/);
  expect(summary.stopRefused).toEqual(["worker_stopped:", "worker_stopped:", "worker_stopped:"]);
  expect(summary.residue).toEqual([]);
  // The leader and the Workers that still fit.
  expect(summary.liveAgents).toBe(FILLED);
}, 60000);
