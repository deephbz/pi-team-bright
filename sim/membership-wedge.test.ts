import fs from "node:fs";
import { expect, it } from "vitest";
import { replayTrace } from "./replay";
import type { WorldTrace } from "./trace-format";

/**
 * Replays the 2026-10-16 wedge in the world: pane geometry runs out and spawns
 * are refused. Each later refusal must name its own cause, and every refused
 * Worker must stop without manual repair. The fake Herdr does not reflow a
 * closed pane, so geometry stays full after a stop. Set PTB_SIM_WEDGE_SUMMARY to a path to
 * record the outcome table before the assertions run.
 */
const FILLED = 16;
it("leaves no unstoppable residue after geometry refusals", async () => {
  const lead = { team: "team-1", actor: "lead" };
  const call = (at: number, tool: string, args: Record<string, unknown>) => ({ at, step: { kind: "tool.call" as const, who: lead, tool, args } });
  const steps: WorldTrace["steps"] = [
    { at: 0, step: { kind: "pi.start", who: lead, session: "session-1", reason: "startup" } },
    call(0, "team_create", { name: "team-1", purpose: "wedge replay", pane_layout: { leader_share: 0.8, worker_tiling: "adaptive" } }),
  ];
  for (let i = 1; i <= FILLED; i++) steps.push(call(i * 100, "ensure_worker", { name: `w${i}`, scope: "fill" }));
  steps.push(call(5000, "ensure_worker", { name: "refused-1", scope: "over capacity" }));
  steps.push(call(5100, "ensure_worker", { name: "refused-2", scope: "over capacity" }));
  steps.push(call(6000, "worker_stop", { worker: "w1" }));
  steps.push(call(7000, "ensure_worker", { name: "after-stop", scope: "fits again" }));
  for (const [i, worker] of ["refused-1", "refused-2", "after-stop"].entries()) steps.push(call(8000 + i * 100, "worker_stop", { worker }));
  const replay = await replayTrace({ version: 1, id: "membership-wedge", source: "synthetic", assumptions: [], setup: { ptbVersion: "baseline", teams: [] }, steps }, { seed: 42 });

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
