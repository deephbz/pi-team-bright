import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableCoordinationTaskStateDeliveryQuery } from "../adapters/durable-coordination-task-state-delivery";
import { DurableModelToolTeamPort } from "../model-tool-contract/durable-model-tool-port";
import { BeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter";
import type { CoordinationQueryBundle, CoordinationTaskReadOutcome } from "./queries";
import { readWorkerRunObservation } from "../utils/sync-liveness";
import { CoordinationObservationService } from "./observation-service";
import { taskProjectionRevision } from "./task-projection-revision";
import { projectToolResult } from "../model-tool-contract/result-projection";
import { projectTui } from "../model-tool-contract/tui-projection";

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
