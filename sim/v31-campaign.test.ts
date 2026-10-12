import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import fc from "fast-check";
import { expect, it } from "vitest";
import { SimWorld } from "./world";
import { WorldReplay, replayTrace, RUNNER_VERSION } from "./replay";
import type { HistoryEntry } from "./history";
import type { WorldTrace, ReplayReceipt } from "./trace-format";
import type { Verdict, WitnessVerdict } from "./monitors/types";
import * as safety from "./monitors/safety";
import * as liveness from "./monitors/liveness";
import * as witnesses from "./monitors/witnesses";
import { families, generatedTrace, scaleTrace, type Sample } from "./v31-schedules";

type Result = Verdict | WitnessVerdict;
const monitors = Object.entries({ ...safety, ...liveness, ...witnesses }).flatMap(([name, run]) => {
  const match = name.match(/^([pes]\d+)/i);
  return match && typeof run === "function" ? [{ id: match[1]!.toUpperCase(), run: run as (history: readonly HistoryEntry[]) => Result }] : [];
});
const bounds = { maxSteps: 100000, maxVirtualMs: 3600000 };
const seed = 20261014;
const runs = Number(process.env.PI_SIM_CAMPAIGN_RUNS ?? 1000);
const output = path.join(__dirname, "results", runs < 1000 ? "v31-smoke" : "v31");
const write = (name: string, value: unknown) => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n"); };

async function execute(trace: WorldTrace, seed: number, replay?: ReplayReceipt) {
  const started = performance.now();
  const world = new SimWorld(seed, { scheduleChoices: replay?.choices });
  let stopped: string | undefined;
  try {
    try { await new WorldReplay(world).run(trace, replay?.bounds ?? bounds); }
    catch (error) { stopped = error instanceof Error ? error.message : String(error); }
    const receipt: ReplayReceipt = { traceId: trace.id, runnerVersion: RUNNER_VERSION, seed,
      choices: world.entropy.choices.filter(choice => choice.label === "schedule").map(choice => choice.value), bounds: replay?.bounds ?? bounds };
    const results = Object.fromEntries(monitors.map(m => [m.id, m.run(world.history)]));
    return { trace, receipt, results, stopped, history: world.history, operations: world.scheduler.decisions.length, wallMs: performance.now() - started };
  } finally { world.dispose(); }
}
type Run = Awaited<ReturnType<typeof execute>>;
const summary = (r: Run) => ({ id: r.trace.id, seed: r.receipt.seed, status: r.stopped ? "stopped-prefix" : "completed", ...(r.stopped ? { stopped: r.stopped } : {}),
  operations: r.operations, wallMs: r.wallMs, historyEntries: r.history.length, results: r.results,
  facts: { journalRows: r.history.filter(e => e.kind === "journal.append").length, committedAppendFaults: r.history.filter(e => e.kind === "fault.effect").length,
    workerBirths: r.history.filter(e => e.kind === "process.birth" && e.process.actorKey.includes("/w")).length } });
const violates = (r: Run, id: string) => !r.stopped && r.results[id]?.status === "violation";

async function minimize(original: Run, id: string) {
  let current = original; let attempts = 0; let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < current.trace.steps.length; index++) {
      const trace = structuredClone(current.trace); trace.steps.splice(index, 1);
      attempts++; const candidate = await execute(trace, original.receipt.seed);
      if (violates(candidate, id)) { current = candidate; changed = true; break; }
    }
    if (changed) continue;
    for (let index = 0; index < current.trace.steps.length; index++) {
      const at = index ? current.trace.steps[index - 1]!.at : 0;
      if (current.trace.steps[index]!.at <= at) continue;
      const trace = structuredClone(current.trace); trace.steps[index]!.at = at;
      attempts++; const candidate = await execute(trace, original.receipt.seed);
      if (violates(candidate, id)) { current = candidate; changed = true; break; }
    }
  }
  current = await execute({ ...current.trace, id: `v31-${id.toLowerCase()}-minimal` }, original.receipt.seed);
  const repeated = await execute(current.trace, current.receipt.seed, current.receipt);
  expect(repeated.stopped).toBeUndefined(); expect(repeated.history).toEqual(current.history); expect(repeated.results).toEqual(current.results);
  expect(violates(current, id)).toBe(true);
  write(`${id}.trace.json`, current.trace); write(`${id}.receipt.json`, current.receipt);
  return { property: id, traceId: current.trace.id, originalId: original.trace.id, steps: current.trace.steps.length, attempts,
    criterion: "1-minimal under single-step deletion and reduction of one timestamp to its predecessor; runtime-valid traces only", replayVerified: true, verdict: current.results[id] };
}

it("records v3.1 fixtures, baseline counterexamples, generated schedules and scale", async () => {
  const started = performance.now(); expect(monitors).toHaveLength(21);
  const outcomes: ReturnType<typeof summary>[] = []; const representatives = new Map<string, Run>();
  const accept = (run: Run) => {
    outcomes.push(summary(run));
    if (!run.stopped) for (const [id, result] of Object.entries(run.results)) if (result.status === "violation" && !representatives.has(id)) representatives.set(id, run);
  };
  for (const file of fs.readdirSync(path.join(__dirname, "fixtures/traces")).filter(f => f.endsWith(".json")).sort()) {
    const trace = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/traces", file), "utf8")) as WorldTrace;
    trace.setup.ptbVersion = "v3.1"; accept(await execute(trace, 42));
  }
  const baselineReceipts = [];
  for (const id of ["P4", "P5", "E5"]) {
    const trace = JSON.parse(fs.readFileSync(path.join(__dirname, `results/baseline/${id}.trace.json`), "utf8")) as WorldTrace;
    const receipt = JSON.parse(fs.readFileSync(path.join(__dirname, `results/baseline/${id}.receipt.json`), "utf8")) as ReplayReceipt;
    let exact: string;
    try { await replayTrace(trace, { receipt }); exact = "accepted"; } catch (error) { exact = (error as Error).message; }
    baselineReceipts.push({ property: id, runnerVersion: receipt.runnerVersion, outcome: exact });
    trace.setup.ptbVersion = "v3.1"; accept(await execute(trace, receipt.seed));
  }
  for (let family = 0; family < families.length; family++) accept(await execute(generatedTrace({ family, seed: 42, gap: 0, repeats: 3 }, `v31-${families[family]}`), 42));
  const samples: Sample[] = [];
  await fc.assert(fc.asyncProperty(fc.record({ family: fc.integer({ min: 0, max: families.length - 1 }), seed: fc.integer({ min: 0, max: 0x7fffffff }), gap: fc.integer({ min: 0, max: 200 }), repeats: fc.integer({ min: 2, max: 8 }) }), async sample => {
    const index = samples.length; samples.push(sample);
    accept(await execute(generatedTrace(sample, `v31-generated-${index}`), sample.seed));
    if ((index + 1) % 50 === 0) { console.info(`v31 campaign ${index + 1}/${runs}: ${((performance.now() - started) / 1000).toFixed(1)}s`); write("progress.json", { seed, samples, outcomes }); }
    return true;
  }), { seed, numRuns: runs, endOnFailure: true });
  const campaignMs = performance.now() - started;
  const scaleTeams = Number(process.env.PI_SIM_SCALE_TEAMS ?? (runs < 1000 ? 1 : 20));
  const scaleWorkers = Number(process.env.PI_SIM_SCALE_WORKERS ?? (runs < 1000 ? 2 : 50));
  const scale = await execute(scaleTrace(scaleTeams, scaleWorkers), 42);
  accept(scale); write("scale.trace.json", scale.trace); write("scale.receipt.json", scale.receipt);
  const minimized = [];
  for (const [id, original] of representatives) { console.info(`shrinking ${id} from ${original.trace.id}`); minimized.push(await minimize(original, id)); }
  const report = { schema: "ptb-sim-v31-campaign/1", source: "synthetic", productionRevision: "1a8a3f663ab04622ee909823ae349da0f94ce245", runnerVersion: RUNNER_VERSION,
    monitorIds: monitors.map(m => m.id), bounds, monitorOptions: "Default bounds; only E5 is currently ruled", generated: { seed, runs, families, samples }, baselineReceipts,
    scale: { teams: scaleTeams, workersPerTeam: scaleWorkers }, outcomes, minimized, timings: { campaignMs, totalIncludingShrinkAndScaleMs: performance.now() - started } };
  write("campaign.json", report); fs.rmSync(path.join(output, "progress.json"), { force: true });
  console.info(`v31 findings ${minimized.map(m => m.property).join(",")}; ${report.timings.totalIncludingShrinkAndScaleMs.toFixed(0)}ms`);
  expect(samples).toHaveLength(runs);
});
