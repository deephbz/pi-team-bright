import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskDeliveryMembership } from "../../test/support/task-delivery-membership";
import * as messaging from "./messaging";
import * as paths from "./paths";
import { taskDeliveryRecoveryPath } from "./paths";
import * as teams from "./teams";
import type { TaskCard } from "../model-tool-contract/task-domain";
import type { TaskReconciliationQuery } from "../task-authority/contracts";
import type { TaskDeliveryRecoveryRecord } from "./task-delivery";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import {
  enqueueTaskChange,
  prepareOwnerTransitionIntent,
  recordTaskDeliveryRecovery,
  readTaskDeliveries,
  reconcileOwnerTransitionOutbox,
  TASK_CHANGE_CUSTOM_TYPE,
  TASK_CHANGE_ACK_ENTRY_TYPE,
  TASK_CHANGE_RESUME_TYPE,
  TaskChangeDelivery,
  type TaskDeliveryMembershipPort,
} from "./task-delivery";

const created: string[] = [];

function reconciliationQuery(
  readOwnerTransitionEvidence: TaskReconciliationQuery["readOwnerTransitionEvidence"],
): TaskReconciliationQuery {
  return {
    readOwnerTransitionEvidence,
    readCurrentTasks: async () => [],
  };
}

async function fixture(suffix: string) {
  const teamName = `task-delivery-${suffix}-${process.pid}-${Date.now()}`;
  created.push(teamName);
  paths.ensureDirs();
  const authorityId = `task_authority_${suffix}`;
  await teams.createTeam(teamName, "lead-session", "lead-agent", "", undefined, undefined, `/tmp/${teamName}-beads`, authorityId, {
    schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: `task_delivery_${suffix}`, projectId: `task-delivery-${suffix}`,
  });
  const sessionFile = `/tmp/${teamName}-worker.jsonl`;
  await teams.addMember(teamName, {
    agentId: `worker@${teamName}`,
    name: "worker",
    agentType: "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile,
    cwd: process.cwd(),
    subscriptions: [],
  });
  const task: TaskCard = {
    id: "1",
    title: "Investigate",
    goal: "Find the cause",
    current_context: "Work has not started.",
    status: "in_progress",
    assignee: "worker",
    version: taskVersionRef("v2"),
  };
  return {
    teamName,
    sessionFile,
    task,
    authorityId,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const teamName of created.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
});

describe("Task-native delivery", () => {
  it("coalesces an identical unresolved delivery recovery obligation", async () => {
    const { teamName, task } = await fixture("recovery-coalesce");
    const version = taskVersionRef(task.version);
    const record: TaskDeliveryRecoveryRecord = {
      teamName,
      taskId: task.id,
      taskVersion: version,
      recipients: ["worker", "reviewer"],
      changeKind: "assigned" as const,
      recordedAt: "2026-08-12T00:00:00.000Z",
      reason: "enqueue-failed" as const,
      taskProjection: { ...task, version, relations: [], dependency_state: { kind: "ready", active_blocker_ids: [] } },
    };

    await recordTaskDeliveryRecovery(record);
    await recordTaskDeliveryRecovery({
      ...record,
      recipients: ["reviewer", "worker", "worker"],
      recordedAt: "2026-08-12T00:00:01.000Z",
      taskProjection: {
        id: record.taskProjection.id,
        title: record.taskProjection.title,
        status: record.taskProjection.status,
        assignee: record.taskProjection.assignee,
        current_context: record.taskProjection.current_context,
        version: record.taskProjection.version,
        goal: "goal" in record.taskProjection ? record.taskProjection.goal : undefined,
        dependency_state: record.taskProjection.dependency_state,
        relations: record.taskProjection.relations,
      } as TaskDeliveryRecoveryRecord["taskProjection"],
    });

    const records = JSON.parse(fs.readFileSync(taskDeliveryRecoveryPath(teamName), "utf8"));
    expect(records).toEqual([record]);
  });

  it("persists an authority-scoped Session-targeted change without creating a Message", async () => {
    const { teamName, sessionFile, task } = await fixture("authority");
    const first = await enqueueTaskChange(teamName, task, "assigned", "team-lead");
    const duplicate = await enqueueTaskChange(teamName, task, "assigned", "team-lead");

    expect(first).not.toBeNull();
    expect(duplicate?.deliveryId).toBe(first?.deliveryId);
    expect(first).toMatchObject({
      recipient: "worker",
      recipientSessionFile: sessionFile,
      ref: { kind: "task", taskId: "1", version: expect.stringMatching(/^v_[0-9a-f]{16}$/) },
      changeKind: "assigned",
      attemptCount: 0,
    });
    expect(await readTaskDeliveries(teamName, "worker")).toHaveLength(1);
    expect(await messaging.readInbox(teamName, "worker", false, false)).toEqual([]);
  });

  it("steers a full Task payload and records successful-turn acknowledgement without changing Task state", async () => {
    const { teamName, sessionFile, task } = await fixture("context");
    const record = await enqueueTaskChange(teamName, task, "assigned", "team-lead");
    const sendMessage = vi.fn();
    const appendEntry = vi.fn();
    const delivery = new TaskChangeDelivery({ sendMessage, appendEntry }, {
      teamName,
      recipient: "worker",
      sessionFile,
      pollMs: 60_000,
      membership: taskDeliveryMembership,
      reconcile: async () => 0,
    });

    await delivery.start([]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [batch, options] = sendMessage.mock.calls[0];
    expect(batch).toMatchObject({
      customType: TASK_CHANGE_CUSTOM_TYPE,
      details: {
        deliveryIds: [record?.deliveryId],
        changes: [{ ref: expect.objectContaining({ taskId: "1", version: expect.stringMatching(/^v_[0-9a-f]{16}$/) }) }],
      },
    });
    expect(batch.content).toContain("Find the cause");
    expect(batch.content).toContain('"current_context": "Work has not started."');
    expect(batch.content).toMatch(/"version": "v_[0-9a-f]{16}"/);
    expect(batch.content).not.toContain("description");
    expect(batch.content).not.toContain("acceptanceCriteria");
    expect(batch.content).not.toContain("provenance");
    expect(batch.content).not.toContain(record?.deliveryId);
    expect(batch.content).not.toContain('"version": "v2"');
    expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });

    await delivery.observeContext([{ role: "custom", customType: batch.customType, details: batch.details }]);
    expect(appendEntry).not.toHaveBeenCalled();
    await delivery.commitPresentedAfterSuccessfulTurn("stop");
    expect(appendEntry).toHaveBeenCalledWith(
      TASK_CHANGE_ACK_ENTRY_TYPE,
      expect.objectContaining({ deliveryIds: [record?.deliveryId] }),
    );
    const persisted = await readTaskDeliveries(teamName, "worker");
    expect(persisted[0].successfulTurnAckAt).toEqual(expect.any(String));
    expect(persisted[0]).not.toHaveProperty("taskSnapshot");
    expect(persisted[0].taskProjection?.status).toBe("in_progress");
    delivery.stop();
  });

  it("resumes an already-presented change only for the exact source Session", async () => {
    const { teamName, sessionFile, task } = await fixture("resume");
    const record = await enqueueTaskChange(teamName, task, "assigned", "team-lead");
    const entries = [{
      type: "custom_message",
      customType: TASK_CHANGE_CUSTOM_TYPE,
      details: {
        authority: "pi-teams-task-delivery",
        schemaVersion: 1,
        teamName,
        recipient: "worker",
        recipientMembershipId: record?.recipientMembershipId,
        targetAgentRef: record?.targetAgentRef,
        deliveryIds: [record?.deliveryId],
        changes: [{ ref: record?.ref, changeKind: "assigned" }],
      },
    }] as any;

    const sourceSend = vi.fn();
    const source = new TaskChangeDelivery({ sendMessage: sourceSend, appendEntry: vi.fn() }, {
      teamName,
      recipient: "worker",
      sessionFile,
      membership: taskDeliveryMembership,
      reconcile: async () => 0,
    });
    await source.start(entries);
    expect(sourceSend).toHaveBeenCalledTimes(1);
    expect(sourceSend.mock.calls[0][0].customType).toBe(TASK_CHANGE_RESUME_TYPE);
    expect(sourceSend.mock.calls[0][0].content).not.toContain(record?.deliveryId);
    source.stop();

    const forkSend = vi.fn();
    const fork = new TaskChangeDelivery({ sendMessage: forkSend, appendEntry: vi.fn() }, {
      teamName,
      recipient: "worker",
      sessionFile: `${sessionFile}.fork`,
      membership: taskDeliveryMembership,
      reconcile: async () => 0,
    });
    await fork.start(entries);
    expect(forkSend).not.toHaveBeenCalled();
    fork.stop();
  });

  it("records the delivery attempt before Session send, and keeps it pending after send failure", async () => {
    const { teamName, sessionFile, task } = await fixture("attempt-before-send");
    const record = await enqueueTaskChange(teamName, task, "assigned", "team-lead");
    let observedAttempt: unknown;
    const delivery = new TaskChangeDelivery({
      sendMessage: vi.fn(() => {
        observedAttempt = JSON.parse(fs.readFileSync(paths.taskDeliveryPath(teamName, "worker"), "utf8"))[0];
        throw new Error("injected send cut");
      }),
      appendEntry: vi.fn(),
    }, {
      teamName, recipient: "worker", sessionFile, membership: taskDeliveryMembership, reconcile: async () => 0,
    });

    await expect(delivery.start([])).rejects.toThrow("injected send cut");
    expect(observedAttempt).toMatchObject({
      deliveryId: record?.deliveryId,
      attemptCount: 1,
      attemptedAt: expect.any(String),
    });
    const [pending] = await readTaskDeliveries(teamName, "worker");
    expect(pending).toMatchObject({
      deliveryId: record?.deliveryId,
      attemptCount: 1,
      attemptedAt: expect.any(String),
    });
    expect(pending).not.toHaveProperty("successfulTurnAckAt");
    delivery.stop();
  });

  it("replays context-staged Task changes after error restart and acks once after toolUse", async () => {
    const { teamName, sessionFile, task } = await fixture("two-phase");
    const record = await enqueueTaskChange(teamName, task, "assigned", "team-lead");
    const firstSend = vi.fn();
    const first = new TaskChangeDelivery({ sendMessage: firstSend, appendEntry: vi.fn() }, {
      teamName, recipient: "worker", sessionFile, membership: taskDeliveryMembership, reconcile: async () => 0,
    });
    await first.start([]);
    const batch = firstSend.mock.calls[0][0];
    await first.observeContext([{ role: "custom", customType: batch.customType, details: batch.details }]);
    await first.commitPresentedAfterSuccessfulTurn("error");
    expect((await readTaskDeliveries(teamName, "worker"))[0].successfulTurnAckAt).toBeUndefined();
    first.stop();

    const presented = {
      type: "custom_message",
      customType: TASK_CHANGE_CUSTOM_TYPE,
      details: batch.details,
    } as any;
    const appendEntry = vi.fn();
    const retrySend = vi.fn();
    const retry = new TaskChangeDelivery({ sendMessage: retrySend, appendEntry }, {
      teamName, recipient: "worker", sessionFile, membership: taskDeliveryMembership, reconcile: async () => 0,
    });
    await retry.start([presented]);
    expect(retrySend.mock.calls[0][0].customType).toBe(TASK_CHANGE_RESUME_TYPE);
    await retry.observeContext([{ role: "custom", customType: TASK_CHANGE_CUSTOM_TYPE, details: batch.details }]);
    await retry.commitPresentedAfterSuccessfulTurn("toolUse");
    await retry.commitPresentedAfterSuccessfulTurn("error");
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith(TASK_CHANGE_ACK_ENTRY_TYPE, expect.objectContaining({ deliveryIds: [record?.deliveryId] }));
    retry.stop();

    const settledSend = vi.fn();
    const ack = { type: "custom", customType: TASK_CHANGE_ACK_ENTRY_TYPE, data: batch.details } as any;
    const settled = new TaskChangeDelivery({ sendMessage: settledSend, appendEntry: vi.fn() }, {
      teamName, recipient: "worker", sessionFile, membership: taskDeliveryMembership, reconcile: async () => 0,
    });
    await settled.start([presented, ack]);
    expect(settledSend).not.toHaveBeenCalled();
    settled.stop();
  });

  it("does not infer self-suppression from a display name", async () => {
    const { teamName, task } = await fixture("self");
    const record = await enqueueTaskChange(teamName, task, "status_changed", "worker");
    expect(record).not.toBeNull();
    expect(await readTaskDeliveries(teamName, "worker")).toHaveLength(1);
  });

  it("scopes Beads Task references to the configured authority without exposing its path", async () => {
    const { teamName, task } = await fixture("beads-authority");
    const config = await teams.readConfig(teamName);
    const workspace = `/tmp/${teamName}-beads-workspace`;
    fs.writeFileSync(paths.configPath(teamName), JSON.stringify({
      ...config,
      taskBackend: "beads",
      taskWorkspace: workspace,
    }, null, 2));

    const record = await enqueueTaskChange(teamName, task, "assigned", "team-lead");
    expect(record?.ref).toMatchObject({ kind: "task", taskId: task.id, version: expect.stringMatching(/^v_[0-9a-f]{16}$/) });
    expect(JSON.stringify(record)).not.toContain(workspace);
  });

  it("rescans when a filesystem hint arrives during an active scan", async () => {
    const { teamName, sessionFile, task } = await fixture("rescan-hint");
    const sendMessage = vi.fn();
    const delivery = new TaskChangeDelivery({ sendMessage, appendEntry: vi.fn() }, {
      teamName,
      recipient: "worker",
      sessionFile,
      pollMs: 60_000,
      membership: taskDeliveryMembership,
      reconcile: async () => 0,
    });
    await delivery.start([]);
    expect(sendMessage).not.toHaveBeenCalled();

    const originalScanOnce = (delivery as any).scanOnce.bind(delivery);
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    let first = true;
    (delivery as any).scanOnce = async (generation: number) => {
      if (first) {
        first = false;
        reached();
        await gate;
        return;
      }
      return originalScanOnce(generation);
    };

    const active = delivery.scan();
    await entered;
    await enqueueTaskChange(teamName, task, "assigned");
    const hinted = delivery.scan();
    release();
    await Promise.all([active, hinted]);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toMatchObject({
      customType: TASK_CHANGE_CUSTOM_TYPE,
      details: { changes: [{ changeKind: "assigned" }] },
    });
    delivery.stop();
  });

  it("recovers a committed assignee transition on a running recipient's fallback scan and acknowledges it once", async () => {
    const { teamName, sessionFile, task } = await fixture("live-assignee-outbox");
    const before = {
      ...task,
      assignee: "team-lead",
      version: taskVersionRef("assignee-v1"),
    };
    const committed = {
      ...before,
      assignee: "worker",
      version: taskVersionRef("assignee-v2"),
    };
    const operationId = "assignee-transition-after-mutator-crash";
    let evidence = { task: before, operationId: undefined as string | undefined };
    const readEvidence = vi.fn(async () => evidence);
    const sendMessage = vi.fn();
    const appendEntry = vi.fn();
    const delivery = new TaskChangeDelivery({ sendMessage, appendEntry }, {
      teamName,
      recipient: "worker",
      sessionFile,
      pollMs: 60_000,
      membership: taskDeliveryMembership,
      reconcile: async () => 0,
      reconcileOwnerOutbox: () => reconcileOwnerTransitionOutbox(teamName, {
        query: reconciliationQuery(readEvidence),
      }),
    });

    await delivery.start([]);
    expect(sendMessage).not.toHaveBeenCalled();

    await prepareOwnerTransitionIntent({
      operationId,
      teamName,
      before,
      afterOwner: "worker",
    });
    evidence = { task: committed, operationId };

    // This is the same scan invoked by the fallback interval. The mutating
    // process never calls completeOwnerTransitionIntent and no recipient
    // process is restarted.
    await delivery.scan();
    expect(readEvidence).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toMatchObject({
      customType: TASK_CHANGE_CUSTOM_TYPE,
      details: {
        changes: [{
          changeKind: "assigned",
          ref: expect.objectContaining({ taskId: task.id, version: expect.stringMatching(/^v_[0-9a-f]{16}$/) }),
        }],
      },
    });
    expect(await readTaskDeliveries(teamName, "worker")).toHaveLength(1);

    await delivery.scan();
    expect(readEvidence).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(await readTaskDeliveries(teamName, "worker")).toHaveLength(1);

    const batch = sendMessage.mock.calls[0][0];
    await delivery.observeContext([{ role: "custom", customType: batch.customType, details: batch.details }]);
    await delivery.commitPresentedAfterSuccessfulTurn("stop");
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect((await readTaskDeliveries(teamName, "worker"))[0].successfulTurnAckAt).toEqual(expect.any(String));
    delivery.stop();
  });

  it("performs no authority read on fallback scans when no assignee intent is prepared", async () => {
    const { teamName, sessionFile } = await fixture("empty-assignee-outbox");
    const readEvidence = vi.fn(async () => {
      throw new Error("authority evidence must not be read without a prepared intent");
    });
    const delivery = new TaskChangeDelivery({ sendMessage: vi.fn(), appendEntry: vi.fn() }, {
      teamName,
      recipient: "worker",
      sessionFile,
      pollMs: 60_000,
      membership: taskDeliveryMembership,
      reconcile: async () => 0,
      reconcileOwnerOutbox: () => reconcileOwnerTransitionOutbox(teamName, {
        query: reconciliationQuery(readEvidence),
      }),
    });

    await delivery.start([]);
    await delivery.scan();
    expect(readEvidence).not.toHaveBeenCalled();
    delivery.stop();
  });

  it("uses the injected exact-recipient port for resolution and successful-turn acknowledgement", async () => {
    const { teamName, sessionFile, task } = await fixture("membership-port");
    const record = await enqueueTaskChange(teamName, task, "assigned");
    const order: string[] = [];
    const currentRecipient = vi.fn(async () => ({ membershipId: record!.recipientMembershipId }));
    const withCurrentRecipient = vi.fn(async <T>(
      _input: Parameters<TaskDeliveryMembershipPort["withCurrentRecipient"]>[0],
      action: () => Promise<T>,
    ): Promise<T> => {
      order.push("lease");
      return await action();
    }) as TaskDeliveryMembershipPort["withCurrentRecipient"];
    const membership: TaskDeliveryMembershipPort = { currentRecipient, withCurrentRecipient };
    const sendMessage = vi.fn((_message: any) => { order.push("send"); });
    const appendEntry = vi.fn(() => { order.push("acknowledge"); });
    const delivery = new TaskChangeDelivery({ sendMessage, appendEntry }, {
      teamName,
      recipient: "worker",
      sessionFile,
      membership,
      reconcile: async () => 0,
    });

    await delivery.start([]);
    const batch = sendMessage.mock.calls[0][0];
    await delivery.observeContext([{ role: "custom", customType: batch.customType, details: batch.details }]);
    await delivery.commitPresentedAfterSuccessfulTurn("stop");

    expect(currentRecipient).toHaveBeenCalledWith({ teamName, recipient: "worker", sessionFile });
    expect(withCurrentRecipient).toHaveBeenCalledTimes(2);
    expect(withCurrentRecipient).toHaveBeenNthCalledWith(
      1,
      { teamName, recipient: "worker", sessionFile, membershipId: record!.recipientMembershipId },
      expect.any(Function),
    );
    expect(withCurrentRecipient).toHaveBeenNthCalledWith(
      2,
      { teamName, recipient: "worker", sessionFile, membershipId: record!.recipientMembershipId },
      expect.any(Function),
    );
    expect(order).toEqual(["lease", "send", "lease", "acknowledge"]);
    expect(appendEntry).toHaveBeenCalledWith(TASK_CHANGE_ACK_ENTRY_TYPE, expect.objectContaining({ deliveryIds: [record!.deliveryId] }));
    delivery.stop();
  });

  it("keeps TaskChangeDelivery free of direct Team reads and leases", () => {
    const source = fs.readFileSync("src/utils/task-delivery.ts", "utf8");
    const consumer = source.slice(source.indexOf("export class TaskChangeDelivery"));
    expect(source).not.toContain("withCurrentSessionBinding");
    expect(consumer).not.toContain("readConfig(");
    expect(consumer).not.toContain("withCurrentSessionBinding");
  });

  it("does not let assignee-outbox recovery failure block an existing recipient spool", async () => {
    const { teamName, sessionFile, task } = await fixture("outbox-recovery-degraded");
    await enqueueTaskChange(teamName, task, "assigned");
    const sendMessage = vi.fn();
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const delivery = new TaskChangeDelivery({ sendMessage, appendEntry: vi.fn() }, {
      teamName,
      recipient: "worker",
      sessionFile,
      pollMs: 60_000,
      membership: taskDeliveryMembership,
      reconcile: async () => 0,
      reconcileOwnerOutbox: async () => { throw new Error("Beads temporarily unavailable"); },
    });

    await delivery.start([]);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringMatching(/continuing local Task delivery/),
      expect.objectContaining({ message: "Beads temporarily unavailable" }),
    );
    delivery.stop();
  });

  it("retries ready-front reconciliation from the durable Worker delivery loop", async () => {
    const { teamName, sessionFile } = await fixture("ready-front-periodic-recovery");
    const reconcileReady = vi.fn()
      .mockRejectedValueOnce(new Error("temporary ready query timeout"))
      .mockResolvedValueOnce([]);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const delivery = new TaskChangeDelivery({ sendMessage: vi.fn(), appendEntry: vi.fn() }, {
      teamName,
      recipient: "worker",
      sessionFile,
      pollMs: 60_000,
      membership: taskDeliveryMembership,
      reconcile: async () => 0,
      reconcileReady,
    });

    await delivery.start([]);
    await delivery.scan();

    expect(reconcileReady).toHaveBeenCalledTimes(2);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringMatching(/ready-front reconciliation failed/),
      expect.objectContaining({ message: "temporary ready query timeout" }),
    );
    delivery.stop();
  });

  it("repairs a ready Task missed before Worker delivery starts on its next owned scan", async () => {
    const { teamName, sessionFile, task } = await fixture("ready-front-missed-delivery");
    const sendMessage = vi.fn();
    let scans = 0;
    const reconcileReady = vi.fn(async () => {
      scans += 1;
      if (scans === 2) await enqueueTaskChange(teamName, task, "assigned", "team-lead");
      return [];
    });
    const delivery = new TaskChangeDelivery({ sendMessage, appendEntry: vi.fn() }, {
      teamName,
      recipient: "worker",
      sessionFile,
      pollMs: 60_000,
      membership: taskDeliveryMembership,
      reconcile: async () => 0,
      reconcileReady,
    });

    await delivery.start([]);
    expect(sendMessage).not.toHaveBeenCalled();
    await delivery.scan();

    expect(reconcileReady).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: TASK_CHANGE_CUSTOM_TYPE,
      details: { changes: [{ ref: { taskId: task.id, version: task.version } }] },
    });
    delivery.stop();
  });

  it("keeps an existing recipient delivery live when ready-front recovery fails", async () => {
    const { teamName, sessionFile, task } = await fixture("ready-front-failure-isolation");
    const record = await enqueueTaskChange(teamName, task, "assigned", "team-lead");
    const sendMessage = vi.fn();
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reconcileReady = vi.fn(async () => { throw new Error("ready authority unavailable"); });
    const delivery = new TaskChangeDelivery({ sendMessage, appendEntry: vi.fn() }, {
      teamName,
      recipient: "worker",
      sessionFile,
      pollMs: 60_000,
      membership: taskDeliveryMembership,
      reconcile: async () => 0,
      reconcileReady,
    });

    await delivery.start([]);

    expect(reconcileReady).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      details: { deliveryIds: [record?.deliveryId] },
    });
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringMatching(/ready-front reconciliation failed/),
      expect.objectContaining({ message: "ready authority unavailable" }),
    );
    delivery.stop();
  });
});
