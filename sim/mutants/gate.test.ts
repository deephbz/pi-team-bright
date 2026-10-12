import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { SimWorld } from "../world";
import { WorldReplay, RUNNER_VERSION } from "../replay";
import type { HistoryEntry } from "../history";
import type { ReplayReceipt, WorldTrace } from "../trace-format";
import type { Verdict, WitnessVerdict } from "../monitors/types";
import * as safety from "../monitors/safety";
import * as liveness from "../monitors/liveness";
import * as witnesses from "../monitors/witnesses";
import { families, generatedTrace } from "../v31-schedules";

// Gate scope: production mutations only. Existing monitors remain unchanged.
const mutant = process.env.PI_MUTANT!;
const mode = process.env.PI_MUTANT_MODE ?? "campaign";
const output = process.env.PI_MUTANT_OUTPUT!;
const bounds = { maxSteps: 10000, maxVirtualMs: 400000 };
const options: Record<string, any> = { P3: { freshnessMs: 10000 }, E1: { deadlineMs: 60000 }, E2: { latencyMs: 60000 }, E3: { boundMs: 60000 }, E4: { thresholdMs: 60000 }, E5: { boundMs: 10000 } };
const monitors = Object.entries({ ...safety, ...liveness, ...witnesses }).flatMap(([name, run]) => {
  const match = name.match(/^([pes]\d+)/i);
  return match && typeof run === "function" ? [{ id: match[1]!.toUpperCase(), run: run as (h: readonly HistoryEntry[], o?: any) => Verdict | WitnessVerdict }] : [];
});
const targets: Record<string, string[]> = { M1: ["P4"], M2: ["retry"], M3: ["E3"], M4: ["P8"], M5: ["E5"], M6: ["P8", "P9"] };
const write = (name: string, value: unknown) => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n"); };
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(output, name), "utf8"));

function retryAfterRefusal(history: readonly HistoryEntry[]): Verdict {
  const refused = history.find(e => e.kind === "durable.launch" && (e.record?.raw.launch as any)?.state === "refused");
  if (!refused) return { status: "not_applicable", missing: "decisive start refusal" };
  const call = history.find(e => e.kind === "tool.call" && e.name === "ensure_worker" && e.sequence > refused.sequence);
  if (!call || call.kind !== "tool.call") return { status: "not_applicable", missing: "retry after refusal" };
  const result = history.find(e => e.kind === "tool.result" && e.callId === call.callId);
  if (!result || result.kind !== "tool.result") return { status: "not_applicable", missing: "retry receipt" };
  return ["created", "recovered"].includes(String(result.result.details?.effect)) ? { status: "pass" }
    : { status: "violation", sequence: result.sequence, detail: "decisive no-start refusal did not permit retry" };
}
async function execute(trace: WorldTrace, seed = 42, replay?: ReplayReceipt) {
  const world = new SimWorld(seed, { scheduleChoices: replay?.choices });
  let stopped: string | undefined;
  try {
    try { await new WorldReplay(world).run(trace, replay?.bounds ?? bounds); }
    catch (error) { stopped = (error as Error).message; }
    const receipt: ReplayReceipt = { traceId: trace.id, runnerVersion: RUNNER_VERSION, seed, bounds: replay?.bounds ?? bounds,
      choices: world.entropy.choices.filter(c => c.label === "schedule").map(c => c.value) };
    const results = Object.fromEntries(monitors.map(m => [m.id, m.run(world.history, options[m.id])]));
    results.retry = retryAfterRefusal(world.history);
    return { trace, receipt, stopped, results, history: world.history };
  } finally { world.dispose(); }
}
type Run = Awaited<ReturnType<typeof execute>>;
const summary = (r: Run) => ({ traceId: r.trace.id, seed: r.receipt.seed, stopped: r.stopped ?? null, results: r.results });
const failure = (r: Run) => !r.stopped && targets[mutant]!.some(id => r.results[id]?.status === "violation");
function targeted(): WorldTrace[] {
  const base = generatedTrace({ family: 0, seed: 42, gap: 0, repeats: 1 }, "unused");
  const boot = base.steps.slice(0, 2);
  const ensure = base.steps[2]!;
  const sync = base.steps.at(-1)!;
  const who = { team: "team-1", actor: "lead" };
  const paged: WorldTrace = { ...base, id: "mutant-multiple-pages", steps: [...boot, ensure,
    { at: 100, step: { kind: "tool.call", who, tool: "team_sync", args: { view: "snapshot" } } },
    ...Array.from({ length: 30 }, (_, i): WorldTrace["steps"][number] => ({ at: 101 + i,
      step: { kind: "tool.call", who, tool: "ensure_worker", args: { name: `extra-${i}`, scope: "Fill multiple journal pages" } } })),
    { ...sync, at: 200 }, { ...sync, at: 201 }] };
  return [
    { ...base, id: "mutant-healthy-launch", steps: [...boot, ensure, { ...sync, at: 70000 }] },
    { ...base, id: "mutant-decisive-refusal", steps: [...boot,
      { at: 0, step: { kind: "fault.set", fault: { source: "herdr.start", mode: "invalid_params" } } }, ensure,
      { at: 100, step: { kind: "fault.clear", source: "herdr.start" } }, { ...ensure, at: 101 }] },
    { ...base, id: "mutant-readiness-hang", steps: [...boot,
      { at: 0, step: { kind: "fault.set", fault: { source: "pi.start", mode: "hang" } } }, ensure] },
    { ...base, id: "mutant-snapshot-updates", steps: [...boot, ensure,
      { at: 100, step: { kind: "tool.call", who, tool: "team_sync", args: { view: "snapshot" } } },
      { at: 101, step: { kind: "tool.call", who, tool: "ensure_worker", args: { name: "w2", scope: "Second worker" } } },
      { at: 102, step: { kind: "tool.call", who, tool: "team_sync", args: { view: "updates" } } },
      { at: 103, step: { kind: "tool.call", who, tool: "team_sync", args: { view: "updates" } } }] },
    paged,
  ];
}

it("records the mutant campaign and exact replay; a survivor is a finding", async () => {
  expect(monitors).toHaveLength(21);
  if (mode === "control-minimal") {
    const trace = read("minimal.trace.json") as WorldTrace;
    const result = await execute(trace, read("minimal.receipt.json").seed);
    write("minimal.control.json", summary(result));
    write("control.evidence.json", evidence(result.history));
    return;
  }
  const traces = [...targeted()];
  for (const file of fs.readdirSync(path.join(__dirname, "../fixtures/traces")).filter(f => f.endsWith(".json")).sort()) traces.push(JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/traces", file), "utf8")));
  for (let family = 0; family < families.length; family++) traces.push(generatedTrace({ family, seed: 42, gap: 0, repeats: 2 }, `mutant-${families[family]}`));
  const samples = fc.sample(fc.record({ family: fc.integer({ min: 0, max: families.length - 1 }), seed: fc.integer({ min: 0, max: 100000 }), gap: fc.integer({ min: 0, max: 200 }), repeats: fc.integer({ min: 2, max: 4 }) }), { seed: 20261013, numRuns: 12 });
  samples.forEach((s, i) => traces.push(generatedTrace(s, `mutant-generated-${i}`)));
  for (const trace of traces) trace.setup.ptbVersion = "v3.1";
  const controls = mode === "control" ? [] : read("control.json").outcomes;
  const outcomes = [];
  let representative: Run | undefined;
  for (const [index, trace] of traces.entries()) {
    const seed = index >= traces.length - samples.length ? samples[index - traces.length + samples.length]!.seed : 42;
    const run = await execute(trace, seed); outcomes.push(summary(run));
    const control = controls.find((c: any) => c.traceId === trace.id);
    if (mode !== "control" && failure(run) && control?.stopped === null && targets[mutant]!.some(id => run.results[id]?.status === "violation" && control.results[id]?.status === "pass")) representative ??= run;
    if (!representative && mode !== "control" && trace.id === targeted()[0]!.id) write("witness.trace.json", trace);
  }
  write(mode === "control" ? "control.json" : "campaign.json", { mutant, mode, runnerVersion: RUNNER_VERSION, bounds, monitorOptions: options, generator: { seed: 20261013, samples }, outcomes });
  if (mode === "control") return;
  let attempts = 0;
  if (representative) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < representative.trace.steps.length; i++) {
        const trace = structuredClone(representative.trace); trace.steps.splice(i, 1);
        attempts++;
        const candidate = await execute(trace, representative.receipt.seed);
        if (failure(candidate)) { representative = candidate; changed = true; break; }
      }
      if (changed) continue;
      for (let i = 0; i < representative.trace.steps.length; i++) {
        const at = i ? representative.trace.steps[i - 1]!.at : 0;
        if (representative.trace.steps[i]!.at <= at) continue;
        const trace = structuredClone(representative.trace); trace.steps[i]!.at = at;
        attempts++;
        const candidate = await execute(trace, representative.receipt.seed);
        if (failure(candidate)) { representative = candidate; changed = true; break; }
      }
    }
  } else {
    // A surviving mutant keeps a completed targeted witness and its replay receipt.
    representative = await execute(targeted()[mutant === "M2" ? 1 : mutant === "M5" ? 2 : mutant === "M6" ? 4 : mutant === "M4" ? 3 : 0]!);
  }
  representative = await execute({ ...representative.trace, id: `${mutant.toLowerCase()}-gate-witness` }, representative.receipt.seed);
  const replayed = await execute(representative.trace, representative.receipt.seed, representative.receipt);
  expect(replayed.stopped).toEqual(representative.stopped);
  expect(replayed.history).toEqual(representative.history);
  expect(replayed.results).toEqual(representative.results);
  write("minimal.trace.json", representative.trace); write("minimal.receipt.json", representative.receipt);
  write("minimal.mutant.json", { ...summary(representative), attempts, criterion: attempts ? "fixed point under single-step deletion and timestamp reduction to predecessor, preserving target violation and completed replay; control checked separately" : "targeted witness; no killing trace found", replayVerified: true });
  // Keep only semantic evidence. Host paths and volatile Session files stay out of Git.
  write("evidence.json", evidence(representative.history));
});

function evidence(history: readonly HistoryEntry[]) {
  return history.flatMap<any>(e => {
    if (e.kind === "tool.result") return [{ sequence: e.sequence, at: e.at, kind: e.kind, name: e.name, effect: e.result.details?.effect, reason: e.result.details?.reason,
      head: e.result.details?.head, workerChanges: (e.result.details?.worker_changes as any[])?.map(w => w.worker), tasks: (e.result.details?.tasks as any[])?.map(t => t.id) }];
    if (e.kind === "journal.append") return [{ sequence: e.sequence, at: e.at, kind: e.kind, cursor: e.event.cursor, type: e.event.type, worker: e.event.worker, phase: e.event.phase }];
    if (e.kind === "durable.launch") return [{ sequence: e.sequence, at: e.at, kind: e.kind, record: e.record ? { membershipId: e.record.membershipId, pendingLaunchId: e.record.pendingLaunchId, launch: e.record.raw.launch } : null }];
    if (e.kind === "lead.entry" && e.stamp) return [{ sequence: e.sequence, at: e.at, kind: e.kind, stamp: e.stamp }];
    if (e.kind === "process.birth" || e.kind === "process.death") return [{ sequence: e.sequence, at: e.at, kind: e.kind, process: e.process }];
    return [];
  });
}
