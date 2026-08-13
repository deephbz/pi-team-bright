import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskCard } from "../model-tool-contract/task-domain";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  reconcile: vi.fn(),
  readConfig: vi.fn(),
  withLock: vi.fn(async (_path: string, action: () => Promise<unknown>) => action()),
}));

vi.mock("../utils/teams", () => ({ readConfig: mocks.readConfig }));
vi.mock("../utils/beads", () => ({ BeadsTaskStore: class {} }));
vi.mock("../utils/lock", () => ({ withLock: mocks.withLock }));
vi.mock("../utils/paths", () => ({ sanitizeName: (value: string) => value, teamDir: (teamName: string) => `/teams/${teamName}` }));
vi.mock("../task-authority/beads-graph-adapter", () => ({
  BeadsTaskGraphAdapter: class {
    create = mocks.create;
  },
}));
vi.mock("../model-tool-contract/beads-task-adapter", () => ({ BeadsTaskAdapter: class {} }));
vi.mock("../task-authority/ready-dispatch", async (original) => ({
  ...await original<typeof import("../task-authority/ready-dispatch")>(),
  reconcileReadyTaskDeliveries: mocks.reconcile,
}));

import { DurableTaskOrchestration } from "./durable-task-orchestration";

function card(id: string, version: `v_${string}`, assignee = "maker"): TaskCard {
  return {
    id,
    title: id,
    goal: `Complete ${id}.`,
    status: "open",
    assignee,
    relations: [],
    dependency_state: { kind: "ready", active_blocker_ids: [] },
    current_context: "Ready.",
    version,
  };
}

const input = {
  operation_id: "graph-op-1",
  tasks: [{ key: "plan", title: "Plan", goal: "Approve plan.", assignee: "maker" }],
  dependencies: [],
};

describe("durable Task graph orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfig.mockResolvedValue({
      taskBackend: "beads",
      taskWorkspace: "/tmp/task-authority",
      taskAuthorityFingerprint: {},
      logicalWorkers: [{ name: "maker" }],
    });
    mocks.reconcile.mockResolvedValue([]);
  });

  it("serializes periodic ready reconciliation per Team before it opens Task authority", async () => {
    const orchestration = new DurableTaskOrchestration({} as any, {} as any);

    await orchestration.reconcileReady("dag-team", "maker");

    expect(mocks.withLock).toHaveBeenCalledOnce();
    expect(mocks.withLock.mock.calls[0]![0]).toBe("/teams/dag-team/.ready-reconciliation");
    expect(mocks.reconcile).toHaveBeenCalledOnce();
  });

  it("publishes committed nodes and relation changes without eager delivery, then dispatches", async () => {
    const plan = card("task-plan", "v_1111111111111111");
    const before = card("task-existing", "v_2222222222222222", "reviewer");
    const after = { ...before, version: "v_3333333333333333" as const };
    mocks.create.mockResolvedValue({
      kind: "created",
      operationId: "graph-op-1",
      replayed: false,
      tasksByKey: { plan },
      readyTaskIds: [plan.id],
      expandedTaskChanges: [{ before, after }],
      expandedTasks: [after],
    });
    const publishTaskMutation = vi.fn(async (_input: unknown) => ({ warnings: [], evidence: {} }));
    const publication = {
      prepareOwnerTransitionIntent: vi.fn(),
      suppressTaskVersionForSession: vi.fn(),
      publishTaskMutation,
      completeOwnerTransitionIntent: vi.fn(),
    };
    const ready = { readDeliveryCoordinates: vi.fn(), enqueueReadyTask: vi.fn() };

    await expect(new DurableTaskOrchestration(publication as any, ready).createGraph("dag-team", input)).resolves.toMatchObject({
      kind: "created",
      replayed: false,
      deliveryWarnings: [],
    });
    expect(publishTaskMutation).toHaveBeenCalledTimes(2);
    expect(publishTaskMutation.mock.calls[0][0]).toMatchObject({ created: true, deliver: false, taskCard: plan });
    expect(publishTaskMutation.mock.calls[1][0]).toMatchObject({ created: false, kind: "relation_changed", deliver: false, taskCard: after });
    expect(mocks.reconcile).toHaveBeenCalledOnce();
  });

  it("keeps exact replay silent and runs only recovery reconciliation", async () => {
    const plan = card("task-plan", "v_1111111111111111");
    mocks.create.mockResolvedValue({
      kind: "created",
      operationId: "graph-op-1",
      replayed: true,
      tasksByKey: { plan },
      readyTaskIds: [plan.id],
      expandedTaskChanges: [],
      expandedTasks: [],
    });
    mocks.reconcile.mockResolvedValue(["recovered warning"]);
    const publication = {
      prepareOwnerTransitionIntent: vi.fn(),
      suppressTaskVersionForSession: vi.fn(),
      publishTaskMutation: vi.fn(),
      completeOwnerTransitionIntent: vi.fn(),
    };

    await expect(new DurableTaskOrchestration(publication as any, {} as any).createGraph("dag-team", input)).resolves.toMatchObject({
      kind: "created",
      replayed: true,
      deliveryWarnings: ["recovered warning"],
    });
    expect(publication.publishTaskMutation).not.toHaveBeenCalled();
    expect(mocks.reconcile).toHaveBeenCalledOnce();
  });

  it("repairs missing committed graph publication without duplicating present evidence", async () => {
    const plan = card("task-plan", "v_1111111111111111");
    const verify = card("task-verify", "v_2222222222222222", "reviewer");
    mocks.create.mockResolvedValue({
      kind: "created",
      operationId: "graph-op-1",
      replayed: true,
      tasksByKey: { plan },
      readyTaskIds: [plan.id],
      expandedTaskChanges: [],
      expandedTasks: [verify],
    });
    const publishTaskMutation = vi.fn(async (_input: unknown) => ({ warnings: [], evidence: {} }));
    const publication = {
      prepareOwnerTransitionIntent: vi.fn(),
      suppressTaskVersionForSession: vi.fn(),
      publishTaskMutation,
      completeOwnerTransitionIntent: vi.fn(),
      hasTaskMutationPublication: vi.fn(async (query: { evidenceKind: string }) => query.evidenceKind === "created"),
    };

    await new DurableTaskOrchestration(publication as any, {} as any).createGraph("dag-team", input);
    expect(publishTaskMutation).toHaveBeenCalledOnce();
    expect(publishTaskMutation.mock.calls[0][0]).toMatchObject({ kind: "relation_changed", taskCard: verify, deliver: false });
  });
});
