import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { replayTrace } from "./replay";
import { generatedTrace, families } from "./v31-schedules";
import type { ReplayReceipt, WorldTrace } from "./trace-format";
import type { HistoryEntry } from "./history";
import { p5ClosesCited, p8CoverageLedger } from "./monitors/safety";
import { e1ExitReachesCarrierView } from "./monitors/liveness";

// Rerun old schedule receipts without replacing their historical evidence.
const output = process.env.PI_SIM_ATTRIBUTION_OUTPUT ?? path.join(__dirname, "results/attribution");
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"));
const write = (file: string, value: unknown) => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, file), JSON.stringify(value, null, 2) + "\n"); };
function evidence(history: readonly HistoryEntry[]) {
  return history.flatMap<any>(e => {
    const base = { sequence: e.sequence, at: e.at, kind: e.kind, origin: e.origin };
    if (e.kind === "process.birth" || e.kind === "process.death") return [{ ...base, process: e.process }];
    if (e.kind === "pane.close") return [{ ...base, pane: e.pane }];
    if (e.kind === "journal.append") return [{ ...base, cursor: e.event.cursor, worker: e.event.worker, phase: e.event.phase }];
    if (e.kind === "tool.result" && e.name === "team_sync") return [{ ...base, details: e.result.details }];
    return [];
  });
}

it("replays affected receipts and retains the hydration race evidence", async () => {
  const inputs: Array<{ id: string; trace: WorldTrace; receipt?: ReplayReceipt; seed?: number }> = [
    ...["P5", "E1"].map(id => ({ id, trace: read(`results/v31/${id}.trace.json`), receipt: read(`results/v31/${id}.receipt.json`) })),
    { id: "M4-old", trace: read("results/mutants/M4/minimal.trace.json"), receipt: read("results/mutants/M4/minimal.receipt.json") },
    ...[1, 25, 50].map((gap, index) => ({ id: `hydration-${gap}`, seed: [42, 20261013, 12345][index],
      trace: generatedTrace({ family: families.indexOf("snapshot-hydration"), seed: 42, gap: gap - 1, repeats: 1 }, `hydration-${gap}`) })),
  ];
  const outcomes = [];
  for (const input of inputs) {
    const result = await replayTrace(input.trace, input.receipt ? { receipt: input.receipt } : { seed: input.seed });
    const repeated = await replayTrace(input.trace, { receipt: result.receipt });
    expect(repeated.history).toEqual(result.history);
    write(`${input.id}.trace.json`, input.trace);
    write(`${input.id}.receipt.json`, result.receipt);
    write(`${input.id}.evidence.json`, evidence(result.history));
    outcomes.push({ id: input.id, replayVerified: true, P5: p5ClosesCited(result.history), P8: p8CoverageLedger(result.history), E1: e1ExitReachesCarrierView(result.history, { deadlineMs: 60000 }) });
  }
  write("results.json", { monitorOptions: { E1: { deadlineMs: 60000 } }, outcomes });
});
