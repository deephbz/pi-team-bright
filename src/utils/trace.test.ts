import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordWorkerLaunchStage, withSemanticTrace } from "./trace";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Worker launch trace", () => {
  it("emits ordered monotonic stages without result payloads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bright-worker-launch-trace-"));
    roots.push(root);
    const trace = path.join(root, "trace.jsonl");
    const secret = "WORKER_LAUNCH_TRACE_PAYLOAD_MUST_NOT_APPEAR";
    vi.stubEnv("PI_TEAMS_TRACE_JSONL", trace);

    await expect(withSemanticTrace("worker_launch", { teamName: "trace-team", workerName: "worker" }, async () => {
      recordWorkerLaunchStage("ensure_started");
      recordWorkerLaunchStage("membership_prepared", { membershipId: "membership-1" });
      recordWorkerLaunchStage("carrier_start_accepted", { membershipId: "membership-1" });
      return secret;
    })).resolves.toBe(secret);

    const raw = fs.readFileSync(trace, "utf8");
    const record = JSON.parse(raw);
    expect(record).toMatchObject({
      operation: "worker_launch",
      teamName: "trace-team",
      workerName: "worker",
      outcome: "ok",
      workerLaunchStages: [
        { stage: "ensure_started" },
        { stage: "membership_prepared", membershipId: "membership-1" },
        { stage: "carrier_start_accepted", membershipId: "membership-1" },
      ],
    });
    const elapsed = record.workerLaunchStages.map((stage: { elapsedMs: number }) => stage.elapsedMs);
    expect(elapsed.every((value: number, index: number) => value >= 0 && (index === 0 || value >= elapsed[index - 1]))).toBe(true);
    expect(record.monotonicDurationMs).toBeGreaterThanOrEqual(elapsed.at(-1));
    expect(raw).not.toContain(secret);
  });
});
