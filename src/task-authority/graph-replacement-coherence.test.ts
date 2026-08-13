import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { configPath, graphRevisionRetirementPath, taskDeliveryRecoveryPath, taskOwnerTransitionOutboxPath, teamDir } from "../utils/paths";
import {
  readCurrentTaskDeliveries,
  readOwnerTransitionIntents,
  readTaskDeliveries,
  readTaskDeliveryTombstones,
  recordTaskDeliveryRecovery,
  retireGraphRevisionDeliveries,
  suppressTaskVersionForSession,
  TaskChangeDelivery,
} from "../utils/task-delivery";
import { writeConfigAtomic } from "../utils/teams";
import { readGraphRevisionRetirement, recordGraphRevisionRetirement } from "../utils/graph-revision-retirement";
import type { TeamConfig } from "../team-authority/contracts";
import type { GraphApplyInput } from "./graph-control";
import { DurableGraphTaskOrchestration } from "./graph-orchestration";
import { taskVersionRef, type TaskVersionRef } from "./task-version-ref";

const created: string[] = [];
const aliases = { default: "test/default", capable: "test/capable" };

function fixture(suffix: string) {
  const teamName = `graph-replacement-${suffix}-${process.pid}-${Date.now()}`;
  created.push(teamName);
  const sessionFile = path.join(teamDir(teamName), "worker-session.jsonl");
  const config: TeamConfig = {
    name: teamName,
    description: "Graph replacement coherence fixture.",
    createdAt: 0,
    leadAgentId: "lead",
    leadSessionId: "lead-session",
    epochId: `epoch-${suffix}`,
    logicalWorkers: [{ name: "worker", scope: "Execute graph work." }],
    members: [{
      membershipId: "membership-worker",
      agentId: "agent-worker",
      name: "worker",
      agentType: "teammate",
      joinedAt: 0,
      sessionFile,
      cwd: process.cwd(),
      subscriptions: [],
    }],
  };
  fs.mkdirSync(teamDir(teamName), { recursive: true });
  writeConfigAtomic(configPath(teamName), config);
  const publication = new DurableTaskMutationPublication();
  const authority = new DurableGraphTaskAuthority(() => aliases);
  const orchestration = new DurableGraphTaskOrchestration(authority, publication, publication, publication);
  return { teamName, sessionFile, publication, authority, orchestration };
}

function graph(operationId: string, expectedGraphVersion?: `g_${string}`, taskKeys = ["keep", "remove"]): GraphApplyInput {
  return {
    operationId,
    ...(expectedGraphVersion ? { expectedGraphVersion } : {}),
    tasks: taskKeys.map((key) => ({ key, title: key, goal: `Complete ${key}.`, assignee: "worker" })),
  };
}

function deliveryTask(id: string, versionSeed: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    goal: `Complete ${id}.`,
    current_context: "Ready.",
    status: "ready" as const,
    assignee: "worker",
    version: taskVersionRef(versionSeed),
    model: "default" as const,
    needs: [],
    state: { kind: "ready" as const },
    attempts_started: 0,
    relations: [],
    dependency_state: { kind: "ready" as const, active_blocker_ids: [] },
    ...overrides,
  };
}

function membership() {
  return {
    currentRecipient: async () => ({ membershipId: "membership-worker" }),
    withCurrentRecipient: async <T>(_input: unknown, action: () => Promise<T>) => action(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const teamName of created.splice(0)) fs.rmSync(teamDir(teamName), { recursive: true, force: true });
});

describe("complete graph replacement coherence", () => {
  it("fences pending Worker presentation while preserving delivery history", async () => {
    const { teamName, sessionFile, orchestration } = fixture("pending");
    const first = await orchestration.applyGraph(teamName, graph("apply-1"));
    expect(first.kind).toBe("applied");
    const before = await readTaskDeliveries(teamName, "worker");
    expect(before.map((record) => record.ref.taskId)).toEqual(["keep"]);

    if (first.kind !== "applied") throw new Error(first.message);
    const second = await orchestration.applyGraph(teamName, graph("apply-2", first.graphVersion, ["remove"]));
    expect(second.kind).toBe("applied");
    expect((await readCurrentTaskDeliveries(teamName, "worker")).map((record) => record.ref.taskId)).toEqual(["remove"]);
    expect(await readTaskDeliveries(teamName, "worker")).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: expect.objectContaining({ taskId: "keep" }), retiredAt: expect.any(String) }),
      expect.objectContaining({ ref: expect.objectContaining({ taskId: "remove" }) }),
    ]));

    const sendMessage = vi.fn();
    const delivery = new TaskChangeDelivery({ sendMessage, appendEntry: vi.fn() }, {
      teamName,
      recipient: "worker",
      sessionFile,
      membership: membership(),
      reconcile: async () => 0,
      reconcileOwnerOutbox: async () => [],
      reconcileReady: async () => [],
    });
    await delivery.start([]);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0]).toMatchObject({
      details: { changes: [{ ref: expect.objectContaining({ taskId: "remove" }) }] },
    });
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain('"taskId":"keep"');
    delivery.stop();
  });

  it("fences a retained Task old version before Worker presentation", async () => {
    const { teamName, sessionFile, publication } = fixture("retained-version-pending");
    const stale = deliveryTask("retained", "retained-v1");
    const current = deliveryTask("retained", "retained-v2", { goal: "Complete the revised retained Task." });
    await publication.enqueueReadyTask(teamName, stale, "worker");

    await retireGraphRevisionDeliveries({
      teamName,
      graphVersion: "g_4444444444444444",
      graphSequence: 1,
      authoritySequence: 1,
      operationId: "replace-retained-version",
      currentTasks: [{ taskId: current.id, taskVersion: current.version }],
      retiredTasks: [{ taskId: stale.id, taskVersion: stale.version }],
    });
    await publication.enqueueReadyTask(teamName, current, "worker");

    const sendMessage = vi.fn();
    const delivery = new TaskChangeDelivery({ sendMessage, appendEntry: vi.fn() }, {
      teamName,
      recipient: "worker",
      sessionFile,
      membership: membership(),
      reconcile: async () => 0,
      reconcileOwnerOutbox: async () => [],
      reconcileReady: async () => [],
    });
    await delivery.start([]);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0]).toMatchObject({
      details: { changes: [{ ref: { taskId: "retained", version: current.version } }] },
    });
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain(stale.version);
    expect(await readTaskDeliveries(teamName, "worker")).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: { kind: "task", taskId: "retained", version: stale.version }, retiredAt: expect.any(String) }),
      expect.objectContaining({ ref: { kind: "task", taskId: "retained", version: current.version } }),
    ]));
    delivery.stop();
  });

  it("fences an already staged delivery before successful-turn acknowledgement", async () => {
    const { teamName, sessionFile, publication } = fixture("staged");
    const version = taskVersionRef("staged-v1");
    const staged = {
      id: "staged",
      title: "Staged",
      goal: "Complete staged.",
      current_context: "Ready.",
      status: "open" as const,
      assignee: "worker",
      version,
      relations: [],
      dependency_state: { kind: "ready" as const, active_blocker_ids: [] },
    };
    await publication.enqueueReadyTask(teamName, staged, "worker");
    const appendEntry = vi.fn();
    const delivery = new TaskChangeDelivery({ sendMessage: vi.fn(), appendEntry }, {
      teamName,
      recipient: "worker",
      sessionFile,
      membership: membership(),
      reconcile: async () => 0,
      reconcileOwnerOutbox: async () => [],
      reconcileReady: async () => [],
    });
    await delivery.start([]);
    const pending = await readCurrentTaskDeliveries(teamName, "worker");
    expect(pending).toHaveLength(1);
    expect(await delivery.observeContext([{
      role: "custom",
      customType: "pi-teams.task-change",
      details: {
        authority: "pi-teams-task-delivery",
        schemaVersion: 1,
        teamName,
        recipient: "worker",
        recipientMembershipId: "membership-worker",
        targetAgentRef: { kind: "session-trace", nativeId: "fixture" },
        deliveryIds: [pending[0].deliveryId],
        changes: [{ ref: pending[0].ref, changeKind: pending[0].changeKind }],
      },
    }])).toBe(1);

    await retireGraphRevisionDeliveries({
      teamName,
      graphVersion: "g_3333333333333333",
      graphSequence: 1,
      authoritySequence: 1,
      operationId: "remove-staged",
      currentTasks: [{ taskId: "current", taskVersion: taskVersionRef("current-v1") }],
      retiredTasks: [{ taskId: "staged", taskVersion: version }],
    });
    await expect(delivery.commitPresentedAfterSuccessfulTurn("stop")).resolves.toBe(0);
    expect(appendEntry).not.toHaveBeenCalled();
    const historical = await readTaskDeliveries(teamName, "worker");
    expect(historical).toEqual([
      expect.objectContaining({ ref: expect.objectContaining({ taskId: "staged" }), retiredAt: expect.any(String) }),
    ]);
    expect(historical[0].successfulTurnAckAt).toBeUndefined();
    delivery.stop();
  });

  it("does not record tool-post-state acknowledgement for a superseded retained version", async () => {
    const { teamName, sessionFile, publication } = fixture("retained-version-suppression");
    const stale = deliveryTask("retained", "retained-suppression-v1");
    const current = deliveryTask("retained", "retained-suppression-v2", { goal: "Current suppression coordinate." });
    await publication.enqueueReadyTask(teamName, stale, "worker");
    await retireGraphRevisionDeliveries({
      teamName,
      graphVersion: "g_9999999999999999",
      graphSequence: 1,
      authoritySequence: 1,
      operationId: "replace-before-suppression",
      currentTasks: [{ taskId: current.id, taskVersion: current.version }],
      retiredTasks: [{ taskId: stale.id, taskVersion: stale.version }],
    });

    await suppressTaskVersionForSession(teamName, "worker", sessionFile, stale);
    expect(await readTaskDeliveryTombstones(teamName, "worker")).toEqual([]);
  });

  it("fences a retained Task old version after staging and before successful-turn acknowledgement", async () => {
    const { teamName, sessionFile, publication } = fixture("retained-version-staged");
    const stale = deliveryTask("retained", "retained-staged-v1");
    const current = deliveryTask("retained", "retained-staged-v2", { goal: "Use revised evidence." });
    await publication.enqueueReadyTask(teamName, stale, "worker");
    const appendEntry = vi.fn();
    const delivery = new TaskChangeDelivery({ sendMessage: vi.fn(), appendEntry }, {
      teamName,
      recipient: "worker",
      sessionFile,
      membership: membership(),
      reconcile: async () => 0,
      reconcileOwnerOutbox: async () => [],
      reconcileReady: async () => [],
    });
    await delivery.start([]);
    const [pending] = await readCurrentTaskDeliveries(teamName, "worker");
    expect(await delivery.observeContext([{
      role: "custom",
      customType: "pi-teams.task-change",
      details: {
        authority: "pi-teams-task-delivery",
        schemaVersion: 1,
        teamName,
        recipient: "worker",
        recipientMembershipId: "membership-worker",
        targetAgentRef: { kind: "session-trace", nativeId: "fixture" },
        deliveryIds: [pending.deliveryId],
        changes: [{ ref: pending.ref, changeKind: pending.changeKind }],
      },
    }])).toBe(1);

    await retireGraphRevisionDeliveries({
      teamName,
      graphVersion: "g_5555555555555555",
      graphSequence: 1,
      authoritySequence: 1,
      operationId: "replace-staged-retained-version",
      currentTasks: [{ taskId: current.id, taskVersion: current.version }],
      retiredTasks: [{ taskId: stale.id, taskVersion: stale.version }],
    });
    await expect(delivery.commitPresentedAfterSuccessfulTurn("stop")).resolves.toBe(0);
    expect(appendEntry).not.toHaveBeenCalled();
    delivery.stop();
  });

  it("retires recovery and owner-transition obligations without erasing evidence", async () => {
    const { teamName } = fixture("derived-stores");
    const version = taskVersionRef("removed-v1");
    const task = {
      id: "removed",
      title: "Removed",
      goal: "Complete removed.",
      current_context: "Ready.",
      status: "open" as const,
      assignee: "worker",
      version,
      relations: [],
      dependency_state: { kind: "ready" as const, active_blocker_ids: [] },
    };
    await recordTaskDeliveryRecovery({
      teamName,
      taskId: task.id,
      taskVersion: version,
      recipients: ["worker"],
      changeKind: "assigned",
      recordedAt: "2026-08-13T00:00:00.000Z",
      reason: "enqueue-failed",
      taskProjection: task,
    });
    fs.mkdirSync(path.dirname(taskOwnerTransitionOutboxPath(teamName)), { recursive: true });
    fs.writeFileSync(taskOwnerTransitionOutboxPath(teamName), JSON.stringify([{
      operationId: "owner-op",
      teamName,
      taskId: "removed",
      beforeVersion: version,
      beforeOwner: "worker",
      targets: [],
      createdAt: "2026-08-13T00:00:00.000Z",
      state: "prepared",
    }]));

    await retireGraphRevisionDeliveries({
      teamName,
      graphVersion: "g_1111111111111111",
      graphSequence: 1,
      authoritySequence: 1,
      operationId: "replacement-op",
      currentTasks: [{ taskId: "current", taskVersion: taskVersionRef("current-v1") }],
      retiredTasks: [{ taskId: "removed", taskVersion: version }],
    });
    expect(JSON.parse(fs.readFileSync(taskDeliveryRecoveryPath(teamName), "utf8"))).toEqual([
      expect.objectContaining({ taskId: "removed", retiredAt: expect.any(String), retiredByGraphVersion: "g_1111111111111111" }),
    ]);
    expect(await readOwnerTransitionIntents(teamName)).toEqual([
      expect.objectContaining({ taskId: "removed", state: "abandoned", retiredAt: expect.any(String) }),
    ]);
  });

  it("retires superseded retained versions in recovery and owner-transition stores", async () => {
    const { teamName } = fixture("derived-version-stores");
    const stale = deliveryTask("retained", "retained-derived-v1");
    const current = deliveryTask("retained", "retained-derived-v2", { goal: "Use the revised retained contract." });
    await recordTaskDeliveryRecovery({
      teamName,
      taskId: stale.id,
      taskVersion: stale.version,
      recipients: ["worker"],
      changeKind: "assigned",
      recordedAt: "2026-08-13T00:00:00.000Z",
      reason: "enqueue-failed",
      taskProjection: stale,
    });
    fs.mkdirSync(path.dirname(taskOwnerTransitionOutboxPath(teamName)), { recursive: true });
    fs.writeFileSync(taskOwnerTransitionOutboxPath(teamName), JSON.stringify([{
      operationId: "owner-version-op",
      teamName,
      taskId: stale.id,
      beforeVersion: stale.version,
      beforeOwner: "worker",
      afterOwner: "worker",
      targets: [],
      createdAt: "2026-08-13T00:00:00.000Z",
      state: "committed",
      committedTaskProjection: stale,
      committedTaskVersion: stale.version,
    }]));

    await retireGraphRevisionDeliveries({
      teamName,
      graphVersion: "g_6666666666666666",
      graphSequence: 1,
      authoritySequence: 1,
      operationId: "replace-derived-retained-version",
      currentTasks: [{ taskId: current.id, taskVersion: current.version }],
      retiredTasks: [{ taskId: stale.id, taskVersion: stale.version }],
    });

    expect(JSON.parse(fs.readFileSync(taskDeliveryRecoveryPath(teamName), "utf8"))).toEqual([
      expect.objectContaining({ taskId: "retained", taskVersion: stale.version, retiredAt: expect.any(String) }),
    ]);
    expect(await readOwnerTransitionIntents(teamName)).toEqual([
      expect.objectContaining({ taskId: "retained", committedTaskVersion: stale.version, state: "abandoned", retiredAt: expect.any(String) }),
    ]);
  });

  it("refuses changed stable graph-operation identity without coupling evolving currentness", async () => {
    const { teamName } = fixture("operation-identity");
    const version = taskVersionRef("operation-identity-v1");
    await recordGraphRevisionRetirement({
      teamName,
      graphVersion: "g_aaaaaaaaaaaaaaaa",
      graphSequence: 1,
      authoritySequence: 1,
      operationId: "stable-operation",
      currentTasks: [{ taskId: "retained", taskVersion: version }],
      retiredTasks: [],
    });
    await expect(recordGraphRevisionRetirement({
      teamName,
      graphVersion: "g_bbbbbbbbbbbbbbbb",
      graphSequence: 2,
      authoritySequence: 2,
      operationId: "stable-operation",
      currentTasks: [{ taskId: "retained", taskVersion: taskVersionRef("operation-identity-v2") }],
      retiredTasks: [{ taskId: "retained", taskVersion: version }],
    })).rejects.toThrow(/conflicts with durable replacement evidence/);
  });

  it("keeps the latest fence when an older graph retirement replays", async () => {
    const { teamName } = fixture("stale-replay");
    await recordGraphRevisionRetirement({
      teamName,
      graphVersion: "g_2222222222222222",
      graphSequence: 2,
      authoritySequence: 2,
      operationId: "newer",
      currentTasks: [{ taskId: "current", taskVersion: taskVersionRef("current-v2") }],
      retiredTasks: [{ taskId: "old", taskVersion: taskVersionRef("old-v1") }],
    });
    await recordGraphRevisionRetirement({
      teamName,
      graphVersion: "g_1111111111111111",
      graphSequence: 1,
      authoritySequence: 1,
      operationId: "older",
      currentTasks: [{ taskId: "old", taskVersion: taskVersionRef("old-v1") }],
      retiredTasks: [],
    });
    expect(JSON.parse(fs.readFileSync(graphRevisionRetirementPath(teamName), "utf8"))).toMatchObject({
      current: {
        graphSequence: 2,
        authoritySequence: 2,
        currentTasks: [{ taskId: "current", taskVersion: taskVersionRef("current-v2") }],
      },
      history: [expect.objectContaining({ operationId: "newer" })],
    });
  });

  it("repairs an ID-only fence only from the matching current graph replay", async () => {
    const { teamName } = fixture("legacy-fence-repair");
    fs.mkdirSync(path.dirname(graphRevisionRetirementPath(teamName)), { recursive: true });
    fs.writeFileSync(graphRevisionRetirementPath(teamName), JSON.stringify({
      schema: "pi-team-bright-graph-revision-retirement/1",
      teamName,
      current: {
        graphVersion: "g_7777777777777777",
        graphSequence: 7,
        authoritySequence: 7,
        operationId: "legacy-current",
        currentTaskIds: ["retained"],
        removedTaskIds: [],
        recordedAt: "2026-08-13T00:00:00.000Z",
      },
      history: [],
    }));
    const currentVersion = taskVersionRef("legacy-repaired-current");

    await expect(recordGraphRevisionRetirement({
      teamName,
      graphVersion: "g_8888888888888888",
      graphSequence: 8,
      authoritySequence: 8,
      operationId: "not-current-replay",
      currentTasks: [{ taskId: "retained", taskVersion: currentVersion }],
      retiredTasks: [],
    })).rejects.toThrow(/requires replay of its exact current graph operation/);

    await recordGraphRevisionRetirement({
      teamName,
      graphVersion: "g_7777777777777777",
      graphSequence: 7,
      authoritySequence: 7,
      operationId: "legacy-current",
      currentTasks: [{ taskId: "retained", taskVersion: currentVersion }],
      retiredTasks: [],
    });
    await expect(readGraphRevisionRetirement(teamName)).resolves.toMatchObject({
      schema: "pi-team-bright-graph-revision-retirement/2",
      current: { currentTasks: [{ taskId: "retained", taskVersion: currentVersion }] },
    });
  });

  it("replays an applied removal without losing first-write retirement history", async () => {
    const { teamName, orchestration } = fixture("removal-replay");
    const initial = await orchestration.applyGraph(teamName, graph("removal-before"));
    if (initial.kind !== "applied") throw new Error(initial.message);
    const replacement = graph("removal-replacement", initial.graphVersion, ["keep"]);

    const applied = await orchestration.applyGraph(teamName, replacement);
    expect(applied).toMatchObject({ kind: "applied", replayed: false, deliveryWarnings: [] });
    const replayed = await orchestration.applyGraph(teamName, replacement);
    expect(replayed).toMatchObject({ kind: "applied", replayed: true, deliveryWarnings: [] });
    expect(JSON.parse(fs.readFileSync(graphRevisionRetirementPath(teamName), "utf8"))).toMatchObject({
      current: {
        operationId: "removal-replacement",
        currentTasks: [expect.objectContaining({ taskId: "keep" })],
        retiredTasks: [expect.objectContaining({ taskId: "remove" })],
      },
      history: expect.arrayContaining([
        expect.objectContaining({ operationId: "removal-replacement", retiredTasks: [expect.objectContaining({ taskId: "remove" })] }),
      ]),
    });
  });

  it("replays one graph apply after claim and result without regressing currentness or first-write retirement history", async () => {
    const { teamName, authority, orchestration } = fixture("apply-transition-replay");
    const initial = await orchestration.applyGraph(teamName, graph("transition-replay-before"));
    if (initial.kind !== "applied") throw new Error(initial.message);
    const replacement = graph("transition-replay-x", initial.graphVersion, ["keep"]);
    const applied = await orchestration.applyGraph(teamName, replacement);
    if (applied.kind !== "applied") throw new Error(applied.message);
    const appliedKeep = await authority.readTask(teamName, "keep");
    if (!appliedKeep) throw new Error("Missing retained Task keep after graph apply.");

    const claimed = await orchestration.transition(teamName, {
      taskId: "keep",
      operationId: "transition-replay-claim",
      expectedVersion: appliedKeep.version as TaskVersionRef,
      transition: "claim",
      worker: "worker",
    }, "worker");
    if (claimed.kind !== "updated") throw new Error(claimed.message);
    const claimedKeep = await authority.readTask(teamName, "keep");
    const claimFence = await readGraphRevisionRetirement(teamName);
    if (!claimedKeep || !claimFence) throw new Error("Claim did not produce current Task and fence evidence.");

    const replayAfterClaim = await orchestration.applyGraph(teamName, replacement);
    expect(replayAfterClaim).toMatchObject({
      kind: "applied",
      replayed: true,
      deliveryWarnings: [],
      tasks: [expect.objectContaining({ id: "keep", status: "in_progress", version: claimedKeep.version })],
    });
    expect(await authority.readTask(teamName, "keep")).toEqual(claimedKeep);
    expect(await readGraphRevisionRetirement(teamName)).toMatchObject({
      current: {
        authoritySequence: claimFence.current.authoritySequence,
        currentTasks: [{ taskId: "keep", taskVersion: claimedKeep.version }],
      },
      history: expect.arrayContaining([expect.objectContaining({
        operationId: "transition-replay-x",
        retiredTasks: [expect.objectContaining({ taskId: "remove" })],
      })]),
    });

    const achieved = await orchestration.transition(teamName, {
      taskId: "keep",
      operationId: "transition-replay-result",
      expectedVersion: claimedKeep.version as TaskVersionRef,
      transition: "goal_achieved",
      worker: "worker",
      evidence: "Retained Task criterion passed after claim replay.",
    }, "worker");
    if (achieved.kind !== "updated") throw new Error(achieved.message);
    const achievedKeep = await authority.readTask(teamName, "keep");
    const achievedFence = await readGraphRevisionRetirement(teamName);
    if (!achievedKeep || !achievedFence) throw new Error("Result did not produce current Task and fence evidence.");

    const replayAfterResult = await orchestration.applyGraph(teamName, replacement);
    expect(replayAfterResult).toMatchObject({
      kind: "applied",
      replayed: true,
      deliveryWarnings: [],
      tasks: [expect.objectContaining({ id: "keep", status: "goal_achieved", version: achievedKeep.version })],
    });
    expect(await authority.readTask(teamName, "keep")).toEqual(achievedKeep);
    const finalFence = await readGraphRevisionRetirement(teamName);
    expect(finalFence).toMatchObject({
      current: {
        authoritySequence: achievedFence.current.authoritySequence,
        currentTasks: [{ taskId: "keep", taskVersion: achievedKeep.version }],
      },
    });
    expect(finalFence?.history.filter((record) => record.operationId === "transition-replay-x")).toHaveLength(1);
    expect(finalFence?.history.find((record) => record.operationId === "transition-replay-x")?.retiredTasks)
      .toEqual([expect.objectContaining({ taskId: "remove" })]);
  });

  it("fences superseded versions across ready, in-progress, achieved, failed-loop, and join states", async () => {
    const { teamName, authority, orchestration } = fixture("state-matrix");
    const tasks: GraphApplyInput["tasks"] = [
      { key: "ready", title: "Ready", goal: "Stay ready.", assignee: "worker" },
      { key: "progress", title: "Progress", goal: "Be in progress.", assignee: "progress-worker" },
      { key: "achieved", title: "Achieved", goal: "Reach success.", assignee: "achieved-worker" },
      { key: "repair", title: "Repair", goal: "Repair failure.", assignee: "repair-worker" },
      { key: "criterion", title: "Criterion", goal: "Fail once.", assignee: "criterion-worker", needs: ["repair"], onGoalFailed: { target: "repair", maxTraversals: 1 } },
      { key: "left", title: "Left", goal: "Pass left.", assignee: "left-worker" },
      { key: "right", title: "Right", goal: "Pass right.", assignee: "right-worker" },
      { key: "join", title: "Join", goal: "Join both.", assignee: "join-worker", needs: ["left", "right"] },
    ];
    const config = JSON.parse(fs.readFileSync(configPath(teamName), "utf8")) as TeamConfig;
    config.logicalWorkers = [...new Set(tasks.map((task) => task.assignee))].map((name) => ({ name, scope: `Execute ${name}.` }));
    writeConfigAtomic(configPath(teamName), config);
    const initial = await orchestration.applyGraph(teamName, { operationId: "matrix-initial", tasks });
    if (initial.kind !== "applied") throw new Error(initial.message);
    const applyTransition = async (taskId: string, transition: "claim" | "goal_achieved" | "goal_failed", operationId: string, evidence?: string) => {
      const task = await authority.readTask(teamName, taskId);
      if (!task) throw new Error(`Missing ${taskId}.`);
      const result = await orchestration.transition(teamName, {
        taskId,
        operationId,
        expectedVersion: task.version as TaskVersionRef,
        transition,
        worker: task.assignee,
        ...(evidence ? { evidence } : {}),
      }, task.assignee);
      if (result.kind !== "updated") throw new Error(result.message);
    };
    await applyTransition("progress", "claim", "matrix-progress-claim");
    await applyTransition("achieved", "claim", "matrix-achieved-claim");
    await applyTransition("achieved", "goal_achieved", "matrix-achieved-result", "Achieved criterion passed.");
    await applyTransition("repair", "claim", "matrix-repair-claim-1");
    await applyTransition("repair", "goal_achieved", "matrix-repair-result-1", "Repair prerequisite passed.");
    await applyTransition("criterion", "claim", "matrix-criterion-claim-1");
    await applyTransition("criterion", "goal_failed", "matrix-criterion-fail-1", "Criterion failed and requested repair.");
    await applyTransition("left", "claim", "matrix-left-claim");
    await applyTransition("left", "goal_achieved", "matrix-left-result", "Left passed.");

    const before = new Map((await authority.readTasks(teamName)).map((task) => [task.id, task]));
    const beforeFence = JSON.parse(fs.readFileSync(graphRevisionRetirementPath(teamName), "utf8"));
    expect(beforeFence.current.authoritySequence).toBeGreaterThan(beforeFence.current.graphSequence);
    expect(before.get("ready")?.status).toBe("ready");
    expect(before.get("progress")?.status).toBe("in_progress");
    expect(before.get("achieved")?.status).toBe("goal_achieved");
    expect(before.get("criterion")?.status).toBe("dependency_waiting");
    expect(before.get("repair")?.status).toBe("ready");
    expect(before.get("join")?.status).toBe("dependency_waiting");
    const revisedInput: GraphApplyInput = {
      operationId: "matrix-revision",
      expectedGraphVersion: initial.graphVersion,
      tasks: tasks.map((task) => ({ ...task, goal: `${task.goal} Revised.` })),
    };
    const revised = await orchestration.applyGraph(teamName, revisedInput);
    if (revised.kind !== "applied") throw new Error(revised.message);
    const after = new Map(revised.tasks.map((task) => [task.id, task]));

    for (const id of tasks.map((task) => task.key)) expect(after.get(id)?.version).not.toBe(before.get(id)?.version);
    expect(JSON.parse(fs.readFileSync(graphRevisionRetirementPath(teamName), "utf8"))).toMatchObject({
      current: {
        authoritySequence: expect.any(Number),
        currentTasks: expect.arrayContaining([...after.values()].map((task) => ({ taskId: task.id, taskVersion: task.version }))),
        retiredTasks: expect.arrayContaining([...before.values()].map((task) => ({ taskId: task.id, taskVersion: task.version }))),
      },
    });
    const replay = await orchestration.applyGraph(teamName, revisedInput);
    expect(replay).toMatchObject({ kind: "applied", replayed: true });
    if (replay.kind !== "applied") throw new Error(replay.message);
    expect(replay.deliveryWarnings).not.toEqual(expect.arrayContaining([expect.stringContaining("retirement")]));
  });

  it("repairs a failed post-commit retirement on exact replay without republishing", async () => {
    const { teamName, authority, publication } = fixture("replay");
    let fail = true;
    const retirement = {
      retireGraphRevision: vi.fn(async (input) => {
        if (fail) throw new Error("simulated fence failure");
        await retireGraphRevisionDeliveries(input);
      }),
    };
    const publish = vi.spyOn(publication, "publishTaskMutation");
    const orchestration = new DurableGraphTaskOrchestration(authority, publication, publication, retirement);
    const input = graph("apply-replay");

    const committed = await orchestration.applyGraph(teamName, input);
    expect(committed).toMatchObject({ kind: "applied", replayed: false, deliveryWarnings: [expect.stringContaining("retirement failed")] });
    const publicationCount = publish.mock.calls.length;
    fail = false;
    const replayed = await orchestration.applyGraph(teamName, input);
    expect(replayed).toMatchObject({ kind: "applied", replayed: true, deliveryWarnings: [] });
    expect(publish).toHaveBeenCalledTimes(publicationCount);
    expect(retirement.retireGraphRevision).toHaveBeenCalledTimes(2);
  });
});
