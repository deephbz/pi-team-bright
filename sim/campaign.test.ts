import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { replayTrace, RUNNER_VERSION } from "./replay";
import { validateWorldTrace } from "./extract/validate";
import type { WorldTrace } from "./trace-format";
import deadPi from "./fixtures/traces/bound-pi-dead.json";

type Outcome = { id: string; seed: number; status: "replayed" | "unsupported"; operations?: number; deadPiReuse?: boolean; error?: string };
async function run(trace: WorldTrace, seed: number): Promise<Outcome> {
  validateWorldTrace(trace);
  try {
    const first = await replayTrace(trace, { seed });
    const second = await replayTrace(trace, { receipt: first.receipt });
    expect(second).toEqual(first);
    const deadWorker = first.processes.findLast(process => process.actor === "team-1/w1")?.alive === false;
    const reused = first.history.some(event => event.kind === "tool.result" && (event.value as any).name === "ensure_worker"
      && (event.value as any).result.details.effect === "reused" && (event.value as any).result.details.worker.carrier === "connected");
    return { id: trace.id, seed, status: "replayed", operations: first.decisions.length, deadPiReuse: deadWorker && reused };
  } catch (error) {
    if (error instanceof Error && error.name === "AssertionError") throw error;
    return { id: trace.id, seed, status: "unsupported", error: error instanceof Error ? error.message : String(error) };
  }
}

it("records bounded synthetic and fast-check real-actor campaign outcomes without treating unsupported inputs as passes", async () => {
  const fixtures: Outcome[] = [];
  for (const file of fs.readdirSync(path.join(__dirname, "fixtures/traces")).filter(file => file.endsWith(".json")).sort()) {
    fixtures.push(await run(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/traces", file), "utf8")), 42));
  }
  const generated: Outcome[] = [];
  const samples = fc.sample(fc.record({ seed: fc.integer({ min: 0, max: 100000 }), killAt: fc.integer({ min: 2, max: 50 }), gap: fc.integer({ min: 1, max: 20 }) }), { seed: 20261012, numRuns: 12 });
  for (const [index, sample] of samples.entries()) {
    const trace = structuredClone(deadPi) as WorldTrace;
    trace.id = `generated-dead-pi-${index}`;
    for (const input of trace.steps) if (input.at >= 2) input.at = input.step.kind === "os.kill" ? sample.killAt : sample.killAt + sample.gap;
    generated.push(await run(trace, sample.seed));
  }
  const report = { runnerVersion: RUNNER_VERSION, sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), scope: "Bounded real-actor campaign; unsupported fixtures are gaps, not verified properties", generator: { seed: 20261012, numRuns: 12, samples }, fixtures, generated };
  console.info(JSON.stringify(report, null, 2));
  if (process.env.PI_SIM_RECORD_CAMPAIGN === "1") fs.writeFileSync(path.join(__dirname, "results/current-campaign.json"), JSON.stringify(report, null, 2) + "\n");
  expect(generated.every(result => result.status === "replayed")).toBe(true);
  expect(fixtures.find(result => result.id === "synthetic-never-starts")?.status).toBe("replayed");
  expect(fixtures.find(result => result.id === "synthetic-bound-pi-dead")?.status).toBe("replayed");
}, 120000);
