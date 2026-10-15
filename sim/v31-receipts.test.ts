import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { replayTrace } from "./replay";
import { e1ExitReachesCarrierView } from "./monitors/liveness";
import type { ReplayReceipt, WorldTrace } from "./trace-format";
import type { HistoryEntry } from "./history";

function historicalE1() {
  const base = path.join(__dirname, "results/v31/E1");
  return {
    trace: JSON.parse(fs.readFileSync(`${base}.trace.json`, "utf8")) as WorldTrace,
    receipt: JSON.parse(fs.readFileSync(`${base}.receipt.json`, "utf8")) as ReplayReceipt,
  };
}

it("PD-1 records the predecessor when recovery outruns the carrier death poll", async () => {
  const { trace, receipt } = historicalE1();
  // PD-1 requires an admitted predecessor. A launch receipt does not await
  // admission; async lease contention can leave the historical at=0 kill too early.
  // Bootstrap through the real authorities, then keep the death/recovery inputs
  // simultaneous and preserve the original seed and 60-second monitor deadline.
  trace.id = `${trace.id}-admitted`;
  trace.setup.teams = [{ team: "team-1", workers: ["w1"] }];
  trace.steps = trace.steps.slice(3);
  const result = await replayTrace(trace, { seed: receipt.seed });
  const repeated = await replayTrace(trace, { receipt: result.receipt });
  expect(repeated.history).toEqual(result.history);
  expect(e1ExitReachesCarrierView(result.history, { deadlineMs: 60000 })).toMatchObject({ status: "pass" });
  const death = result.history.find(e => e.kind === "process.death" && e.process.processKind === "worker_pi");
  if (death?.kind !== "process.death") throw new Error("Missing predecessor death");
  const predecessor = result.history.find(e => e.kind === "durable.runtime" && e.sequence < death.sequence
    && e.record?.pid === death.process.generation.pid
    && e.record.osBirthToken === death.process.generation.osBirthToken
    && e.record.bootId === death.process.generation.bootId
    && e.record.membershipId === death.process.membershipId);
  expect(predecessor).toBeDefined();
  const recovery = result.history.find(e => e.kind === "tool.result" && e.name === "ensure_worker" && e.sequence > death.sequence);
  expect(recovery?.kind === "tool.result" && recovery.result.details).toMatchObject({ kind: "worker_ensured", effect: "recovered" });
  const exits = result.history.filter(e => e.kind === "journal.append" && e.event.carrier?.to === "gone"
    && e.event.carrier.generation?.osBirthToken === death.process.generation.osBirthToken);
  expect(exits).toHaveLength(1);
  const replacement = result.history.find(e => e.kind === "durable.runtime" && e.record?.agentName === "w1"
    && e.sequence > death.sequence && e.record.osBirthToken !== death.process.generation.osBirthToken);
  expect(replacement).toBeDefined();
  expect(exits[0]!.sequence).toBeLessThan(replacement!.sequence);
}, 30000);

it("reports a pre-admission death as launch_stalled at the 15-second launch bound", async () => {
  const { trace, receipt } = historicalE1();
  trace.id = `${trace.id}-pre-admission`;
  // Keep the original launch, immediate kill and immediate recovery attempt.
  // Query both sides of the product's 15-second stalled-launch threshold.
  const recovery = trace.steps[4]!.step;
  trace.steps.splice(5, 0, { at: 14999, step: recovery }, { at: 15000, step: recovery });
  const result = await replayTrace(trace, { seed: receipt.seed });
  expect((await replayTrace(trace, { receipt: result.receipt })).history).toEqual(result.history);
  const launches = result.history.filter(e => e.kind === "tool.result" && e.name === "ensure_worker");
  expect(launches).toHaveLength(4);
  const [created, immediate, pending, stalled] = launches;
  if (created?.kind !== "tool.result" || immediate?.kind !== "tool.result"
    || pending?.kind !== "tool.result" || stalled?.kind !== "tool.result") throw new Error("Missing launch results");
  const launchId = created.result.details?.launchId;
  expect(launchId).toEqual(expect.any(String));
  expect(created.result.details).toMatchObject({ kind: "worker_ensured", effect: "created" });
  for (const entry of [immediate, pending]) {
    expect(entry.result.details).toMatchObject({ kind: "attention", reason: "launch_pending", nextActionHint: "wait", launchId });
  }
  expect(stalled.result.details).toMatchObject({ kind: "attention", reason: "launch_stalled", nextActionHint: "ask_human", launchId });
  expect(stalled.at - created.at).toBeLessThanOrEqual(15000);
  expect(result.history.some(e => e.kind === "durable.runtime" && e.record?.agentName === "w1")).toBe(false);
  expect(result.history.filter(e => e.kind === "process.birth" && e.process.processKind === "worker_pi")).toHaveLength(1);
}, 30000);

it("refuses a Worker alert before runtime admission", async () => {
  const { trace } = historicalE1();
  trace.id = "pre-admission-alert";
  trace.steps = [...trace.steps.slice(0, 3), { at: 0, step: {
    kind: "tool.call", who: { team: "team-1", actor: "w1" }, tool: "alert_send",
    args: { kind: "attention", text: "Synthetic pre-binding alert" },
  } }];
  let history: HistoryEntry[] = [];
  await expect(replayTrace(trace, { seed: 42, setup: runner => { history = runner.world.history; } }))
    .rejects.toThrow("Current Worker Session binding is unavailable: not_bound");
  expect(history.some(e => e.kind === "process.birth" && e.process.processKind === "worker_pi")).toBe(true);
  expect(history.some(e => e.kind === "durable.runtime" && e.record?.agentName === "w1")).toBe(false);
  expect(history.some(e => e.kind === "tool.result" && e.name === "alert_send")).toBe(false);
}, 30000);
