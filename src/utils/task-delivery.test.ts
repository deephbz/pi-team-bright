import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as messaging from "./messaging";
import * as paths from "./paths";
import * as teams from "./teams";
import type { TaskCard } from "../model-tool-contract/task-domain";
import type { TaskReconciliationQuery } from "../task-authority/contracts";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import {
  enqueueTaskChange,
  prepareOwnerTransitionIntent,
  readTaskDeliveries,
  reconcileOwnerTransitionOutbox,
  TASK_CHANGE_CUSTOM_TYPE,
  TASK_CHANGE_ACK_ENTRY_TYPE,
  TASK_CHANGE_RESUME_TYPE,
  TaskChangeDelivery,
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
      reconcile: async () => 0,
    });
    await fork.start(entries);
    expect(forkSend).not.toHaveBeenCalled();
    fork.stop();
  });

  it("replays context-staged Task changes after error restart and acks once after toolUse", async () => {
    const { teamName, sessionFile, task } = await fixture("two-phase");
    const record = await enqueueTaskChange(teamName, task, "assigned", "team-lead");
    const firstSend = vi.fn();
    const first = new TaskChangeDelivery({ sendMessage: firstSend, appendEntry: vi.fn() }, {
      teamName, recipient: "worker", sessionFile, reconcile: async () => 0,
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
      teamName, recipient: "worker", sessionFile, reconcile: async () => 0,
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
      teamName, recipient: "worker", sessionFile, reconcile: async () => 0,
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
});
