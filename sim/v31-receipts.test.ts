import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { replayTrace } from "./replay";
import type { WorldTrace, ReplayReceipt } from "./trace-format";
import * as safety from "./monitors/safety";
import * as liveness from "./monitors/liveness";

const directory = path.join(__dirname, "results/v31");
const report = JSON.parse(fs.readFileSync(path.join(directory, "campaign.json"), "utf8"));
for (const finding of report.minimized) it(`replays persisted ${finding.traceId} and preserves its monitor finding`, async () => {
  const trace = JSON.parse(fs.readFileSync(path.join(directory, `${finding.property}.trace.json`), "utf8")) as WorldTrace;
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, `${finding.property}.receipt.json`), "utf8")) as ReplayReceipt;
  const result = await replayTrace(trace, { receipt });
  const monitor = Object.entries({ ...safety, ...liveness }).find(([name]) => name.match(/^([pe]\d+)/i)?.[1]?.toUpperCase() === finding.property)![1] as Function;
  expect(result.receipt).toEqual(receipt);
  expect(monitor(result.history, report.monitorOptions[finding.property])).toEqual(finding.verdict);
}, 30000);
