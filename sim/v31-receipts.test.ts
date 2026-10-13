import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { replayTrace } from "./replay";
import { e1ExitReachesCarrierView } from "./monitors/liveness";
import type { ReplayReceipt, WorldTrace } from "./trace-format";

it("PD-1 records the predecessor when recovery outruns the carrier death poll", async () => {
  const base = path.join(__dirname, "results/v31/E1");
  const trace = JSON.parse(fs.readFileSync(`${base}.trace.json`, "utf8")) as WorldTrace;
  const receipt = JSON.parse(fs.readFileSync(`${base}.receipt.json`, "utf8")) as ReplayReceipt;
  // Pre-replacement publication adds a lock operation. Replay the counterexample's
  // world inputs and seed, then verify the new scheduler receipt on the fixed path.
  const result = await replayTrace(trace, { seed: receipt.seed });
  const repeated = await replayTrace(trace, { receipt: result.receipt });
  expect(repeated.history).toEqual(result.history);
  expect(e1ExitReachesCarrierView(result.history, { deadlineMs: 60000 })).toMatchObject({ status: "pass" });
  const death = result.history.find(e => e.kind === "process.death" && e.process.processKind === "worker_pi");
  if (death?.kind !== "process.death") throw new Error("Missing predecessor death");
  const exits = result.history.filter(e => e.kind === "journal.append" && e.event.carrier?.to === "gone"
    && e.event.carrier.generation?.osBirthToken === death.process.generation.osBirthToken);
  expect(exits).toHaveLength(1);
  const replacement = result.history.find(e => e.kind === "durable.runtime" && e.record?.agentName === "w1"
    && e.sequence > death.sequence && e.record.osBirthToken !== death.process.generation.osBirthToken);
  expect(replacement).toBeDefined();
  expect(exits[0]!.sequence).toBeLessThan(replacement!.sequence);
}, 30000);
