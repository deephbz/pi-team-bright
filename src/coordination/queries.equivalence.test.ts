import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableGraphTaskStateDeliveryQuery } from "../adapters/durable-graph-task-read";
import type { GraphTaskOrchestrationPort } from "../task-authority/graph-orchestration";
import type { CoordinationQueryBundle, CoordinationTaskReadOutcome } from "./queries";
import { readWorkerRunObservation } from "../utils/sync-liveness";
import { taskDeliveryPath } from "../utils/paths";
import { CoordinationObservationService } from "./observation-service";
import { taskProjectionRevision } from "./task-projection-revision";
import { projectToolResult } from "../model-tool-contract/result-projection";
import { projectTui } from "../model-tool-contract/tui-projection";
import { composedDurableModelToolPort } from "../../test/support/durable-model-tool-port";

const teamName = "coordination-query-equivalence";
const emptyGraph = { readTasks: vi.fn(async () => []) } as unknown as GraphTaskOrchestrationPort;
const task = {
  id: "task-a",
  title: "Canonical Task",
  goal: "Preserve ordered complete hydration.",
  current_context: "Current Task context.",
  status: "open",
  relations: [],
  dependency_state: { kind: "ready", active_blocker_ids: [] },
  version: "v_0123456789abcdef",
} as any;

afterEach(() => vi.restoreAllMocks());

describe("durable Coordination query equivalence", () => {
  it("preserves ordered multi-ID graph outcomes and propagates authority failure", async () => {
    const readTasks = vi.fn(async () => [task]);
    const query = new DurableGraphTaskStateDeliveryQuery({ readTasks } as unknown as GraphTaskOrchestrationPort);
    await expect(query.readTasks(teamName, ["task-b", "task-a", "task-a"])).resolves.toEqual([undefined, { kind: "found", task }, { kind: "found", task }]);
    expect(readTasks).toHaveBeenCalledWith(teamName, ["task-b", "task-a", "task-a"]);
    readTasks.mockRejectedValueOnce(new Error("Graph unavailable"));
    await expect(query.listTaskIds(teamName)).rejects.toThrow("Graph unavailable");
  });

  it("reads only Task-delivery evidence for Coordination and distinguishes absent, pending, settled, and malformed records", async () => {
    const deliveryTeam = `coordination-delivery-evidence-${process.pid}-${Date.now()}`;
    const deliveryFile = taskDeliveryPath(deliveryTeam, "worker");
    const query = new DurableGraphTaskStateDeliveryQuery(emptyGraph);
    try {
      await expect(query.readDeliveryEvidence(deliveryTeam, "worker")).resolves.toEqual({ known: true, pending: false });

      fs.mkdirSync(path.dirname(deliveryFile), { recursive: true });
      const record = { taskProjection: task, ref: { kind: "task", taskId: task.id, version: task.version } };
      fs.writeFileSync(deliveryFile, JSON.stringify([{ ...record, deliveryId: "pending" }, { ...record, deliveryId: "settled", successfulTurnAckAt: "2026-08-10T00:00:00.000Z" }]));
      await expect(query.readDeliveryEvidence(deliveryTeam, "worker")).resolves.toEqual({ known: true, pending: true });

      fs.writeFileSync(deliveryFile, JSON.stringify([{ ...record, deliveryId: "settled", successfulTurnAckAt: "2026-08-10T00:00:00.000Z" }]));
      await expect(query.readDeliveryEvidence(deliveryTeam, "worker")).resolves.toEqual({ known: true, pending: false });

      fs.writeFileSync(deliveryFile, "not-json");
      await expect(query.readDeliveryEvidence(deliveryTeam, "worker")).resolves.toEqual({ known: false, pending: false });
    } finally {
      fs.rmSync(path.dirname(deliveryFile), { recursive: true, force: true });
    }
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
      receivedAlerts: { readRecentReceivedAlerts: async () => ({ alerts: [], omitted: 0 }) },
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

  it("requires explicit composition for the legacy DurableModelToolTeamPort facade", () => {
    expect(() => composedDurableModelToolPort()).not.toThrow();
    const root = process.cwd();
    const extension = fs.readFileSync(path.join(root, "extensions/index.ts"), "utf8");
    expect(extension.match(/const coordinationQueries = createDurableCoordinationQueries\(graphTaskOrchestration\);/g)).toHaveLength(1);
    expect(extension).toContain("new DurableModelToolCoordinationApplication(modelToolBindings, coordinationObservationService)");
  });

  it("fences canonical contracts and each durable query to its owner record boundary", () => {
    const root = process.cwd();
    const source = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
    const contracts = source("src/coordination/queries.ts");
    const teamRuntime = source("src/adapters/durable-coordination-team-runtime.ts");
    const taskState = source("src/adapters/durable-graph-task-read.ts");
    const alertActuation = source("src/adapters/durable-coordination-alert-actuation.ts");
    const observationService = source("src/coordination/observation-service.ts");

    expect(contracts).not.toMatch(/(?:Beads|TaskAuthorityRecord|Member\b|AgentRuntimeStatus|InboxMessage)/);
    expect(teamRuntime).toMatch(/from "\.\.\/utils\/runtime"/);
    expect(teamRuntime).not.toMatch(/taskDeliveryPath|inboxPath|BeadsTaskAdapter/);
    expect(taskState).toMatch(/GraphTaskOrchestrationPort/);
    expect(taskState).toMatch(/readCurrentTaskDeliveries/);
    expect(taskState).not.toMatch(/inboxPath|readRuntimeStatus/);
    expect(alertActuation).toMatch(/inboxPath/);
    expect(alertActuation).not.toMatch(/taskDeliveryPath|readRuntimeStatus|BeadsTaskAdapter/);
    expect(observationService).toContain("this.coordinationQueries.taskStateDelivery.listTaskIds(team)");
    expect(observationService).toContain("this.coordinationQueries.taskStateDelivery.readTasks(team, ids)");
    expect(observationService).toContain("deriveWorkerRunObservation(member, { runtime, taskDelivery, alertInbox })");
  });
});
