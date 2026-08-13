import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableCoordinationTaskStateDeliveryQuery } from "../adapters/durable-coordination-task-state-delivery";
import type { TaskAuthorityRecordEnvelope } from "../utils/beads";
import { DurableModelToolTeamPort } from "../model-tool-contract/durable-model-tool-port";
import { createReadOnlyBeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";
import type { CoordinationQueryBundle, CoordinationTaskReadOutcome } from "./queries";
import { readWorkerRunObservation } from "../utils/sync-liveness";
import { taskDeliveryPath } from "../utils/paths";
import { CoordinationObservationService } from "./observation-service";
import { taskProjectionRevision } from "./task-projection-revision";
import { projectToolResult } from "../model-tool-contract/result-projection";
import { projectTui } from "../model-tool-contract/tui-projection";
import { composedDurableModelToolPort } from "../../test/support/durable-model-tool-port";

const teamName = "coordination-query-equivalence";
const emptyReadFactory = createReadOnlyBeadsTaskAdapterFactory({
  readTaskAuthorityRecordEnvelope: vi.fn(),
  readTaskAuthorityRecordEnvelopes: vi.fn(async () => []),
  listTaskIds: vi.fn(async () => []),
});
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
  it("preserves ordered multi-ID Task outcomes and typed hydration failure", async () => {
    const outcomes: CoordinationTaskReadOutcome[] = [
      { kind: "found", task: { ...task, version: "v_5ee07e909280ff0e" } },
      {
        kind: "contract_gap",
        reason: "task_metadata_absent",
        taskId: "task-b",
        version: "v_5e86669cea4e8c4c" as any,
        message: "Task task-b has no canonical pi_teams_task metadata; compatibility fields are not a Task definition.",
      },
      undefined,
    ];
    const records: Array<TaskAuthorityRecordEnvelope | undefined> = [
      { task: { id: "task-a", title: task.title, description: "Compatibility", acceptanceCriteria: "Compatibility", status: "open", relations: [], version: "raw-a", provenance: { authority: "beads" as const, teamName } }, taskMetadata: { schema: "pi-teams-task/1", goal: task.goal, current_context: task.current_context } },
      { task: { id: "task-b", title: "Task b", description: "Compatibility", acceptanceCriteria: "Compatibility", status: "open", relations: [], version: "raw-b", provenance: { authority: "beads" as const, teamName } } },
      undefined,
    ];
    const readPort = {
      readTaskAuthorityRecordEnvelope: vi.fn(),
      readTaskAuthorityRecordEnvelopes: vi.fn(async () => records),
      listTaskIds: vi.fn(),
    };
    const query = new DurableCoordinationTaskStateDeliveryQuery(createReadOnlyBeadsTaskAdapterFactory(readPort));

    await expect(query.readTasks(teamName, ["task-a", "task-b", "task-c"])).resolves.toEqual(outcomes);
    expect(readPort.readTaskAuthorityRecordEnvelopes).toHaveBeenCalledOnce();
    expect(readPort.readTaskAuthorityRecordEnvelopes).toHaveBeenCalledWith(teamName, ["task-a", "task-b", "task-c"]);
  });

  it("reads only Task-delivery evidence for Coordination and distinguishes absent, pending, settled, and malformed records", async () => {
    const deliveryTeam = `coordination-delivery-evidence-${process.pid}-${Date.now()}`;
    const deliveryFile = taskDeliveryPath(deliveryTeam, "worker");
    const query = new DurableCoordinationTaskStateDeliveryQuery(emptyReadFactory);
    try {
      await expect(query.readDeliveryEvidence(deliveryTeam, "worker")).resolves.toEqual({ known: true, pending: false });

      fs.mkdirSync(path.dirname(deliveryFile), { recursive: true });
      fs.writeFileSync(deliveryFile, JSON.stringify([{ deliveryId: "pending" }, { deliveryId: "settled", successfulTurnAckAt: "2026-08-10T00:00:00.000Z" }]));
      await expect(query.readDeliveryEvidence(deliveryTeam, "worker")).resolves.toEqual({ known: true, pending: true });

      fs.writeFileSync(deliveryFile, JSON.stringify([{ deliveryId: "settled", successfulTurnAckAt: "2026-08-10T00:00:00.000Z" }]));
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
    expect(extension.match(/const coordinationQueries = createDurableCoordinationQueries\(taskReadAdapterFactory, graphTaskOrchestration\);/g)).toHaveLength(1);
    expect(extension).toContain("new DurableModelToolCoordinationApplication(modelToolBindings, coordinationObservationService)");
  });

  it("keeps query transition failures unacknowledged until a persisted caught-up result", async () => {
    const calls: string[] = [];
    let binding: any = {
      teamName,
      epochId: "epoch-1",
      sessionFile: "/sessions/leader.jsonl",
      purpose: "Characterize query transitions.",
      logicalWorkers: [{ name: "worker", scope: "verify" }],
      members: [{ name: "team-lead", agentType: "lead", membershipId: "lead-1", sessionFile: "/sessions/leader.jsonl", isActive: true }, { name: "worker", agentType: "teammate", membershipId: "worker-1", sessionFile: "/sessions/worker.jsonl", isActive: true }],
    };
    let taskRead: "ok" | "unavailable" = "ok";
    let runtime: any = { membershipId: "other-membership", pid: 42, startedAt: 1, runState: "settled" };
    let commits = 0;
    const queries: CoordinationQueryBundle = {
      teamRuntime: {
        readLeaderBinding: vi.fn(async () => { calls.push("binding"); return binding; }),
        readRuntime: vi.fn(async () => { calls.push("runtime"); return runtime; }),
      },
      taskStateDelivery: {
        listTaskIds: vi.fn(async () => { calls.push("task:list"); if (taskRead === "unavailable") throw new Error("Task authority unavailable."); return []; }),
        readTasks: vi.fn(async () => { calls.push("task:read"); return []; }),
        readDeliveryEvidence: vi.fn(async () => { calls.push("delivery"); return { known: true, pending: false }; }),
      },
      alertActuation: { readInboxEvidence: vi.fn(async () => { calls.push("alert"); return { known: true, pending: false }; }) },
    };
    const hidden = {
      schema: "pi-teams-hidden-observation/1" as const,
      teamEpochId: "epoch-1", exactSessionId: "/sessions/leader.jsonl", acknowledgedEntryId: "base",
      acknowledgedLineage: ["base"], teamEventCursor: "0", authorityRevisions: { task_projection: taskProjectionRevision([], []) }, updatedAt: new Date(0).toISOString(),
    };
    const service = new CoordinationObservationService(queries, {
      projectNonterminalTaskIds: () => [],
      projectTaskChanges: () => ({ kind: "projected", changes: [] }),
    }, {
      readHidden: vi.fn(async () => ({ kind: "found", projection: hidden })),
      commitHidden: vi.fn(async () => { commits++; return { kind: "committed", projection: { ...hidden, acknowledgedEntryId: "success", acknowledgedLineage: ["base", "success"] } }; }),
      readEvents: vi.fn(() => ({ events: [], cursor: "0", headCursor: "0" })),
      readEventCursor: vi.fn(() => "0"), waitEvents: vi.fn(), readFailureHints: vi.fn(() => ({ hints: [], headCursor: "0" })),
    } as any);
    service.setBranchContext("leader", ["base"]);

    const unknown = await service.readTeamSync("leader", "updates", new AbortController().signal, "unknown");
    expect(unknown).toEqual({ kind: "indeterminate", message: "Worker run-state evidence is incomplete; no observation was published." });
    expect(calls).toEqual(["binding", "task:list", "task:read", "delivery", "alert", "runtime"]);
    expect(service.pending("leader")).toBeUndefined();
    expect(commits).toBe(0);

    calls.length = 0;
    taskRead = "unavailable";
    const unavailable = await service.readTeamSync("leader", "updates", new AbortController().signal, "unavailable");
    expect(unavailable).toEqual({ kind: "unavailable", reason: "task_authority_unavailable", message: "Task authority unavailable." });
    expect(calls).toEqual(["binding", "task:list"]);
    expect(service.pending("leader")).toBeUndefined();
    expect(commits).toBe(0);

    calls.length = 0;
    taskRead = "ok";
    runtime = { membershipId: "worker-1", pid: 42, startedAt: 1, runState: "settled" };
    const caughtUp = await service.readTeamSync("leader", "updates", new AbortController().signal, "success");
    expect(caughtUp).toEqual({ kind: "caught_up", head: 0, epochId: "epoch-1" });
    expect(calls).toEqual(["binding", "task:list", "task:read", "delivery", "alert", "runtime"]);
    expect(commits).toBe(0);
    expect(projectToolResult("team_sync", { kind: "caught_up", head: 0, epoch_id: "epoch-1", state_changed: false, observation_advanced: true })).toEqual({ kind: "caught_up", head: 0, epoch_id: "epoch-1" });
    expect(projectTui({ tool: "team_sync", details: { kind: "caught_up", head: 0, epoch_id: "epoch-1", state_changed: false, observation_advanced: true }, expanded: false })).toEqual(expect.arrayContaining([expect.stringContaining("caught_up")]));
    await expect(service.acknowledge("leader", "success", ["base", "success"])).resolves.toBe(true);
    expect(commits).toBe(1);
    expect(service.pending("leader")).toBeUndefined();

    binding = undefined;
    await expect(service.readTeamSync("leader", "updates", new AbortController().signal, "replacement"))
      .resolves.toEqual({ kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." });
    expect(commits).toBe(1);
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
