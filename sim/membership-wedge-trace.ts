import type { WorldTrace } from "./trace-format";

/** Workers that fit the simulated pane before Herdr geometry refuses a spawn. */
export const WEDGE_FILLED = 16;

/**
 * The 2026-10-16 wedge: fill the pane geometry, refuse two spawns, stop one
 * Worker, spawn again, then stop every refused Worker.
 */
export function wedgeTrace(): WorldTrace {
  const lead = { team: "team-1", actor: "lead" };
  const call = (at: number, tool: string, args: Record<string, unknown>) => ({ at, step: { kind: "tool.call" as const, who: lead, tool, args } });
  const steps: WorldTrace["steps"] = [
    { at: 0, step: { kind: "pi.start", who: lead, session: "session-1", reason: "startup" } },
    call(0, "team_create", { name: "team-1", purpose: "wedge replay", pane_layout: { leader_share: 0.8, worker_tiling: "adaptive" } }),
  ];
  for (let i = 1; i <= WEDGE_FILLED; i++) steps.push(call(i * 100, "ensure_worker", { name: `w${i}`, scope: "fill" }));
  steps.push(call(5000, "ensure_worker", { name: "refused-1", scope: "over capacity" }));
  steps.push(call(5100, "ensure_worker", { name: "refused-2", scope: "over capacity" }));
  steps.push(call(6000, "worker_stop", { worker: "w1" }));
  steps.push(call(7000, "ensure_worker", { name: "after-stop", scope: "fits again" }));
  for (const [i, worker] of ["refused-1", "refused-2", "after-stop"].entries()) steps.push(call(8000 + i * 100, "worker_stop", { worker }));
  return { version: 1, id: "membership-wedge", source: "synthetic", assumptions: [], setup: { ptbVersion: "baseline", teams: [] }, steps };
}
