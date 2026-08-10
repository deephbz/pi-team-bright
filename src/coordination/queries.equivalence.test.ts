import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableCoordinationTaskStateDeliveryQuery } from "../adapters/durable-coordination-task-state-delivery";
import { DurableModelToolTeamPort } from "../model-tool-contract/durable-model-tool-port";
import { BeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter";
import type { CoordinationQueryBundle, CoordinationTaskReadOutcome } from "./queries";
import { readWorkerRunObservation } from "../utils/sync-liveness";

const teamName = "coordination-query-equivalence";
const task = {
  id: "task-a",
  title: "Canonical Task",
  goal: "Preserve ordered complete hydration.",
  current_context: "Current Task context.",
  status: "open",
  version: "v_0123456789abcdef",
} as any;

afterEach(() => vi.restoreAllMocks());

describe("durable Coordination query equivalence", () => {
  it("preserves ordered multi-ID Task outcomes and typed hydration failure", async () => {
    const outcomes: CoordinationTaskReadOutcome[] = [
      { kind: "found", task },
      {
        kind: "contract_gap",
        reason: "task_metadata_invalid",
        taskId: "task-b",
        version: "v_1111111111111111" as any,
        message: "Task metadata is invalid.",
      },
      undefined,
    ];
    const readMany = vi.spyOn(BeadsTaskAdapter.prototype, "readMany").mockResolvedValue(outcomes as any);
    const query = new DurableCoordinationTaskStateDeliveryQuery();

    await expect(query.readTasks(teamName, ["task-a", "task-b", "task-c"])).resolves.toEqual(outcomes);
    expect(readMany).toHaveBeenCalledOnce();
    expect(readMany).toHaveBeenCalledWith(["task-a", "task-b", "task-c"]);
  });

  it("derives exact Worker state only from injected Team runtime and Task/Alert actuation evidence", async () => {
    const queries: CoordinationQueryBundle = {
      teamRuntime: { readRuntime: vi.fn().mockResolvedValue({ membershipId: "member-1", pid: 42, startedAt: 100, runState: "active" }) },
      taskStateDelivery: {
        listTaskIds: vi.fn(),
        readTasks: vi.fn(),
        readDeliveryEvidence: vi.fn().mockResolvedValue({ known: true, pending: true }),
      },
      alertActuation: { readInboxEvidence: vi.fn().mockResolvedValue({ known: true, pending: false }) },
    };
    const member = {
      name: "worker", membershipId: "member-1", sessionFile: "/sessions/worker.jsonl", isActive: true,
    } as any;

    await expect(readWorkerRunObservation(teamName, member, queries)).resolves.toEqual({
      worker: "worker",
      membershipId: "member-1",
      generation: { membershipId: "member-1", pid: 42, startedAt: 100 },
      state: "active",
      actuationPending: true,
    });
    expect(queries.teamRuntime.readRuntime).toHaveBeenCalledWith(teamName, member);
    expect(queries.taskStateDelivery.readDeliveryEvidence).toHaveBeenCalledWith(teamName, "worker");
    expect(queries.alertActuation.readInboxEvidence).toHaveBeenCalledWith(teamName, "worker");
  });

  it("keeps the legacy DurableModelToolTeamPort constructor usable while production injects one query bundle", () => {
    expect(() => new DurableModelToolTeamPort()).not.toThrow();
    const root = process.cwd();
    const extension = fs.readFileSync(path.join(root, "extensions/index.ts"), "utf8");
    expect(extension.match(/const coordinationQueries = createDurableCoordinationQueries\(\);/g)).toHaveLength(1);
    expect(extension).toContain("new DurableModelToolTeamPort(workerLaunchBridge, lifecycle, taskAdapterFactory, alertSender, coordinationQueries, coordinationObservationService)");
  });

  it("fences canonical contracts and each durable query to its owner record boundary", () => {
    const root = process.cwd();
    const source = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
    const contracts = source("src/coordination/queries.ts");
    const teamRuntime = source("src/adapters/durable-coordination-team-runtime.ts");
    const taskState = source("src/adapters/durable-coordination-task-state-delivery.ts");
    const alertActuation = source("src/adapters/durable-coordination-alert-actuation.ts");
    const observationService = source("src/coordination/observation-service.ts");

    expect(contracts).not.toMatch(/(?:Beads|TaskAuthorityRecord|Member\b|AgentRuntimeStatus|InboxMessage)/);
    expect(teamRuntime).toMatch(/from "\.\.\/utils\/runtime"/);
    expect(teamRuntime).not.toMatch(/taskDeliveryPath|inboxPath|BeadsTaskAdapter/);
    expect(taskState).toMatch(/BeadsTaskAdapter/);
    expect(taskState).toMatch(/taskDeliveryPath/);
    expect(taskState).not.toMatch(/inboxPath|readRuntimeStatus/);
    expect(alertActuation).toMatch(/inboxPath/);
    expect(alertActuation).not.toMatch(/taskDeliveryPath|readRuntimeStatus|BeadsTaskAdapter/);
    expect(observationService).toContain("this.coordinationQueries.taskStateDelivery.listTaskIds(teamName)");
    expect(observationService).toContain("this.coordinationQueries.taskStateDelivery.readTasks(teamName, taskIds)");
    expect(observationService).toContain("deriveWorkerRunObservation(member, { runtime, taskDelivery, alertInbox })");
  });
});
