import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskDeliveryMembership } from "../../test/support/task-delivery-membership";
import type { TaskCard } from "../task-authority/task-domain";
import { taskVersionRef } from "../task-authority/task-version-ref";
import {
  enqueueTaskChange,
  enqueueTaskChangeForExactRecipient,
  readTaskDeliveries,
  TASK_CHANGE_ACK_ENTRY_TYPE,
  TASK_CHANGE_CUSTOM_TYPE,
  TASK_CHANGE_RESUME_TYPE,
  TaskChangeDelivery,
} from "./task-delivery";
import * as paths from "./paths";
import * as teams from "./teams";

const created: string[] = [];

function card(assignee = "worker"): TaskCard {
  return {
    id: "task-1",
    title: "Characterize delivery",
    goal: "Preserve Task delivery behavior before its boundary moves.",
    current_context: "The delivery behavior needs an executable characterization.",
    status: "in_progress",
    assignee,
    version: taskVersionRef("delivery-v1"),
  };
}

async function fixture(suffix: string) {
  const teamName = `task-change-delivery-characterization-${suffix}-${process.pid}-${Date.now()}`;
  created.push(teamName);
  paths.ensureDirs();
  const sessionFile = `/tmp/${teamName}-worker.jsonl`;
  await teams.createTeam(teamName, `/tmp/${teamName}-lead.jsonl`, "lead-agent", "", undefined, undefined, `/tmp/${teamName}-beads`, "task-authority", {
    schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: teamName, projectId: teamName,
  });
  const member = {
    agentId: `worker@${teamName}`,
    name: "worker",
    agentType: "teammate" as const,
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile,
    cwd: process.cwd(),
    subscriptions: [],
  };
  await teams.addMember(teamName, member);
  const config = await teams.readConfig(teamName);
  const current = config.members.find((candidate) => candidate.name === "worker" && candidate.isActive !== false)!;
  return { teamName, sessionFile, current, task: card() };
}

function delivery(teamName: string, sessionFile: string, sink = { sendMessage: vi.fn(), appendEntry: vi.fn() }) {
  return {
    sink,
    delivery: new TaskChangeDelivery(sink, {
      teamName,
      recipient: "worker",
      sessionFile,
      pollMs: 60_000,
      membership: taskDeliveryMembership,
      reconcile: async () => 0,
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const teamName of created.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
});

describe("TaskChangeDelivery current behavior characterization", () => {
  it("resolves an assignee to its active binding and refuses an exact stale target", async () => {
    const { teamName, sessionFile, current, task } = await fixture("recipient");
    const normal = await enqueueTaskChange(teamName, task, "assigned");
    expect(normal).toMatchObject({
      recipient: "worker",
      recipientMembershipId: current.membershipId,
      recipientSessionFile: sessionFile,
    });

    await teams.deactivateMember(teamName, "worker", "replaced");
    const replacementSession = `${sessionFile}.replacement`;
    await teams.addMember(teamName, {
      agentId: `replacement@${teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile: replacementSession,
      cwd: process.cwd(),
      subscriptions: [],
    });
    const config = await teams.readConfig(teamName);
    const stale = await enqueueTaskChangeForExactRecipient(config, card(), {
      recipient: "worker",
      recipientMembershipId: current.membershipId!,
      recipientSessionFile: sessionFile,
      changeKind: "assigned",
    });
    const replacement = await enqueueTaskChange(teamName, card(), "assigned");

    expect(stale).toBeNull();
    expect(replacement).toMatchObject({ recipientSessionFile: replacementSession });
  });

  it("sends before context staging, then appends acknowledgement before durable acknowledgement", async () => {
    const { teamName, sessionFile, task } = await fixture("order");
    const record = await enqueueTaskChange(teamName, task, "assigned");
    let acknowledgementWasDurableAtAppend: unknown;
    const current = delivery(teamName, sessionFile, {
      sendMessage: vi.fn(),
      appendEntry: vi.fn(() => {
        acknowledgementWasDurableAtAppend = fs.existsSync(paths.taskDeliveryPath(teamName, "worker"))
          && JSON.parse(fs.readFileSync(paths.taskDeliveryPath(teamName, "worker"), "utf8"))[0].successfulTurnAckAt;
      }),
    });

    await current.delivery.start([]);
    const batch = current.sink.sendMessage.mock.calls[0][0];
    expect(batch.customType).toBe(TASK_CHANGE_CUSTOM_TYPE);
    expect(await current.delivery.commitPresentedAfterSuccessfulTurn("stop")).toBe(0);
    expect(current.sink.appendEntry).not.toHaveBeenCalled();

    await current.delivery.observeContext([{ role: "custom", customType: batch.customType, details: batch.details }]);
    expect(await current.delivery.commitPresentedAfterSuccessfulTurn("stop")).toBe(1);
    expect(current.sink.appendEntry).toHaveBeenCalledWith(TASK_CHANGE_ACK_ENTRY_TYPE, expect.objectContaining({ deliveryIds: [record!.deliveryId] }));
    expect(acknowledgementWasDurableAtAppend).toBeUndefined();
    expect((await readTaskDeliveries(teamName, "worker"))[0].successfulTurnAckAt).toEqual(expect.any(String));
    current.delivery.stop();
  });

  it("does not acknowledge a staged delivery after its Membership is replaced", async () => {
    const { teamName, sessionFile, task } = await fixture("replacement");
    await enqueueTaskChange(teamName, task, "assigned");
    const current = delivery(teamName, sessionFile);
    await current.delivery.start([]);
    const batch = current.sink.sendMessage.mock.calls[0][0];
    await current.delivery.observeContext([{ role: "custom", customType: batch.customType, details: batch.details }]);

    await teams.deactivateMember(teamName, "worker", "replaced");
    await teams.addMember(teamName, {
      agentId: `replacement@${teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile: `${sessionFile}.replacement`,
      cwd: process.cwd(),
      subscriptions: [],
    });

    expect(await current.delivery.commitPresentedAfterSuccessfulTurn("stop")).toBe(0);
    expect(current.sink.appendEntry).not.toHaveBeenCalled();
    expect((await readTaskDeliveries(teamName, "worker"))[0].successfulTurnAckAt).toBeUndefined();
  });

  it("keeps failed and error-stopped presentation pending, then replays its stable ID until one acknowledgement", async () => {
    const { teamName, sessionFile, task } = await fixture("replay");
    const record = await enqueueTaskChange(teamName, task, "assigned");
    const failed = delivery(teamName, sessionFile, { sendMessage: vi.fn(() => { throw new Error("send cut"); }), appendEntry: vi.fn() });
    await expect(failed.delivery.start([])).rejects.toThrow("send cut");
    failed.delivery.stop();

    const retry = delivery(teamName, sessionFile);
    await retry.delivery.start([]);
    const batch = retry.sink.sendMessage.mock.calls[0][0];
    expect(batch.details.deliveryIds).toEqual([record!.deliveryId]);
    await retry.delivery.observeContext([{ role: "custom", customType: batch.customType, details: batch.details }]);
    expect(await retry.delivery.commitPresentedAfterSuccessfulTurn("error")).toBe(0);
    retry.delivery.stop();

    const resumed = delivery(teamName, sessionFile);
    await resumed.delivery.start([{ type: "custom_message", customType: TASK_CHANGE_CUSTOM_TYPE, details: batch.details } as any]);
    expect(resumed.sink.sendMessage.mock.calls[0][0]).toMatchObject({
      customType: TASK_CHANGE_RESUME_TYPE,
      details: { deliveryIds: [record!.deliveryId] },
    });
    await resumed.delivery.observeContext([{ role: "custom", customType: batch.customType, details: batch.details }]);
    expect(await resumed.delivery.commitPresentedAfterSuccessfulTurn("toolUse")).toBe(1);
    expect(await resumed.delivery.commitPresentedAfterSuccessfulTurn("stop")).toBe(0);
    expect(resumed.sink.appendEntry).toHaveBeenCalledTimes(1);
    resumed.delivery.stop();
  });
});
