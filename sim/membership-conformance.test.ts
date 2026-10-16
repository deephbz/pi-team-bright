import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { checkMembershipConformance, formatTimeline } from "./membership-conformance";
import type { HistoryEntry } from "./history";
import { WorldReplay } from "./replay";
import type { WorldTrace } from "./trace-format";
import { wedgeTrace } from "./membership-wedge-trace";
import { families, generatedTrace } from "./v31-schedules";
import { SimWorld } from "./world";

const fixtures = path.join(__dirname, "fixtures/traces");
/** Coverage across every run in this file; PTB_SIM_CONFORMANCE_SUMMARY writes it to a path. */
const coverage = { runs: 0, stopped: 0, snapshots: 0, changes: 0, starts: 0, witnesses: {} as Record<string, number> };
function check(run: { history: readonly HistoryEntry[]; stopped?: string }) {
  const result = checkMembershipConformance(run.history);
  coverage.runs++; if (run.stopped) coverage.stopped++;
  coverage.snapshots += result.snapshots; coverage.changes += result.changes; coverage.starts += result.starts;
  for (const steps of result.timelines.values()) for (const step of steps) coverage.witnesses[step.witness] = (coverage.witnesses[step.witness] ?? 0) + 1;
  return result;
}
const traces = fs.readdirSync(fixtures).filter(name => name.endsWith(".json")).sort();

/** Like the v3.1 campaign: a replay that stops early still yields the history it reached. */
async function history(trace: WorldTrace, seed: number): Promise<{ history: readonly HistoryEntry[]; stopped?: string }> {
  const world = new SimWorld(seed);
  try {
    let stopped: string | undefined;
    try { await new WorldReplay(world).run(trace, { maxSteps: 100000, maxVirtualMs: 3600000 }); }
    catch (error) { stopped = error instanceof Error ? error.message : String(error); }
    return { history: [...world.history], stopped };
  } finally { world.dispose(); }
}

it.each(traces)("conforms to the Membership machine: %s", async name => {
  const trace = JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8")) as WorldTrace;
  trace.setup.ptbVersion = "v3.1";
  expect(check(await history(trace, 42)).violations).toEqual([]);
}, 60000);

it.each(families.map((family, index) => [family, index] as const))("conforms on generated %s schedules", async (_family, index) => {
  for (const seed of [1, 2, 3]) {
    const run = await history(generatedTrace({ family: index, seed, gap: seed * 37, repeats: 3 }, `conformance-${index}-${seed}`), seed);
    expect(check(run).violations).toEqual([]);
  }
}, 120000);

it("conforms on the geometry-refusal wedge replay", async () => {
  expect(check(await history(wedgeTrace(), 42)).violations).toEqual([]);
}, 60000);

it("checked real lifecycle changes and Herdr starts", () => {
  if (process.env.PTB_SIM_CONFORMANCE_SUMMARY) fs.writeFileSync(process.env.PTB_SIM_CONFORMANCE_SUMMARY, `${JSON.stringify(coverage, null, 2)}\n`);
  expect(coverage.runs).toBe(traces.length + families.length * 3 + 1);
  expect(coverage.changes).toBeGreaterThan(coverage.runs);
  expect(coverage.starts).toBeGreaterThan(coverage.runs);
  for (const witness of ["initial", "record_target", "complete_launch", "bind_session", "deactivate", "relaunch"]) expect(coverage.witnesses[witness] ?? 0).toBeGreaterThan(0);
});

it("prints a one-line-per-step Membership timeline", async () => {
  const trace = JSON.parse(fs.readFileSync(path.join(fixtures, "bound-pi-dead.json"), "utf8")) as WorldTrace;
  const result = checkMembershipConformance((await history(trace, 42)).history);
  const worker = [...result.timelines.values()].find(steps => steps.some(step => step.witness === "bind_session"))!;
  const lines = formatTimeline(worker);
  expect(lines[0]).toMatch(/initial +-> prepared launch=requested target=no/);
  expect(lines.some(line => /record_target +-> prepared launch=requested target=yes/.test(line))).toBe(true);
  expect(lines.some(line => /bind_session +-> bound/.test(line))).toBe(true);
}, 60000);

// Negative traces: the checker must reject a forged lifecycle change and an unauthorized start.
const base = { version: 1, origin: "world", at: 0 } as const;
const member = (fields: Record<string, unknown>) => ({ membershipId: "m1", name: "w", agentType: "teammate", isActive: true, ...fields });
const snapshot = (sequence: number, members: unknown[]) => ({ ...base, sequence, kind: "durable.team", team: "t", path: "config.json", record: { members } }) as unknown as HistoryEntry;
const start = (sequence: number, pane: string) => ({ ...base, sequence, kind: "exec.call", actor: { team: "t", actor: "lead" }, callId: "c", mode: "async", command: "herdr", args: ["agent", "start", pane] }) as unknown as HistoryEntry;
const target = { backend: "herdr", kind: "pane", targetId: "pane-1" };
const launch = { launchId: "L1", state: "requested", requestedAt: 0 };

it("rejects a bound Session that changes without a new Membership", () => {
  const result = checkMembershipConformance([
    snapshot(1, [member({ sessionFile: "/s1.jsonl", terminalTarget: target })]),
    snapshot(2, [member({ sessionFile: "/s2.jsonl", terminalTarget: target })]),
  ]);
  expect(result.violations.map(v => v.kind)).toEqual(["unwitnessed_change"]);
});

it("rejects a launch capability that changes without a relaunch record", () => {
  const result = checkMembershipConformance([
    snapshot(1, [member({ pendingLaunchId: "L1", launch })]),
    snapshot(2, [member({ pendingLaunchId: "L2", launch })]),
  ]);
  expect(result.violations.map(v => v.kind)).toEqual(["unwitnessed_change"]);
});

it("rejects a Herdr start that precedes the target record", () => {
  const result = checkMembershipConformance([
    snapshot(1, [member({ pendingLaunchId: "L1", launch })]),
    start(2, "pane-1"),
    snapshot(3, [member({ pendingLaunchId: "L1", launch, terminalTarget: target })]),
  ]);
  expect(result.violations.map(v => v.kind)).toEqual(["unauthorized_start"]);
});
