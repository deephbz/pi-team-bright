import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveWorkerRunObservation, readWorkerRunObservation, livenessIsComplete, livenessIsProductive } from "./sync-liveness";
import { writeRuntimeStatus } from "./runtime";
import { inboxPath, taskDeliveryPath, teamDir } from "./paths";
import { createDurableCoordinationQueries } from "../adapters/durable-coordination-queries";
import { createReadOnlyBeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";

const roots: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const queries = createDurableCoordinationQueries(createReadOnlyBeadsTaskAdapterFactory({
  readTaskAuthorityRecordEnvelope: async () => undefined as any,
  readTaskAuthorityRecordEnvelopes: async () => [],
  listTaskIds: async () => [],
}));
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function member(overrides: Record<string, unknown> = {}) {
  return { membershipId: "membership-1", agentId: "agent-1", name: "worker", agentType: "teammate", joinedAt: 1, cwd: "/tmp", subscriptions: [], isActive: true, sessionFile: "session.json", ...overrides } as any;
}

describe("exact Worker run-state evidence", () => {
  it("derives liveness without reading durable records", () => {
    expect(deriveWorkerRunObservation(member(), {
      runtime: { membershipId: "membership-1", pid: 42, startedAt: 10, runState: "settled" },
      taskDelivery: { known: true, pending: false },
      alertInbox: { known: true, pending: false },
    })).toMatchObject({ state: "settled", generation: { membershipId: "membership-1", pid: 42, startedAt: 10 } });
  });

  it("distinguishes active and settled exact generations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-liveness-runtime-"));
    roots.push(root);
    process.env.PI_CODING_AGENT_DIR = root;
    const team = "liveness-test";
    fs.mkdirSync(teamDir(team), { recursive: true });
    await writeRuntimeStatus(team, "worker", { pid: process.pid, startedAt: 10, runState: "active" }, "membership-1");
    await expect(readWorkerRunObservation(team, member(), queries)).resolves.toMatchObject({ state: "active", generation: { membershipId: "membership-1", pid: process.pid, startedAt: 10 } });
    await writeRuntimeStatus(team, "worker", { runState: "settled" }, "membership-1");
    await expect(readWorkerRunObservation(team, member(), queries)).resolves.toMatchObject({ state: "settled" });
  });

  it("does not classify a mismatched generation as settled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-liveness-runtime-"));
    roots.push(root);
    process.env.PI_CODING_AGENT_DIR = root;
    const team = "liveness-test";
    fs.mkdirSync(teamDir(team), { recursive: true });
    await writeRuntimeStatus(team, "worker", { pid: process.pid, startedAt: 10, runState: "settled" }, "other-membership");
    const result = await readWorkerRunObservation(team, member(), queries);
    expect(result.state).toBe("unknown");
    expect(livenessIsComplete([result])).toBe(false);
    expect(livenessIsProductive([result])).toBe(false);
  });

  it("treats malformed delivery and inbox evidence as unknown", async () => {
    const team = `liveness-malformed-${process.pid}`;
    fs.rmSync(teamDir(team), { recursive: true, force: true });
    fs.mkdirSync(teamDir(team), { recursive: true });
    roots.push(teamDir(team));
    fs.mkdirSync(path.dirname(taskDeliveryPath(team, "worker")), { recursive: true });
    fs.writeFileSync(taskDeliveryPath(team, "worker"), "not-json");
    fs.mkdirSync(path.dirname(inboxPath(team, "worker")), { recursive: true });
    fs.writeFileSync(inboxPath(team, "worker"), JSON.stringify({ malformed: true }));
    await writeRuntimeStatus(team, "worker", { pid: process.pid, startedAt: 10, runState: "settled" }, "membership-1");
    const result = await readWorkerRunObservation(team, member(), queries);
    expect(result.state).toBe("unknown");
    expect(livenessIsComplete([result])).toBe(false);
  });
});
