import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { IdentifiedInboxMessage, Member, TeamConfig } from "./models";
import type { TaskCard } from "../model-tool-contract/task-domain";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import {
  DIRECT_MESSAGE_ACK_ENTRY_TYPE,
  DIRECT_MESSAGE_CUSTOM_TYPE,
  DIRECT_MESSAGE_RESUME_TYPE,
  DirectMessageDelivery,
} from "./message-delivery";
import * as paths from "./paths";
import {
  TASK_CHANGE_ACK_ENTRY_TYPE,
  TASK_CHANGE_CUSTOM_TYPE,
  TASK_CHANGE_RESUME_TYPE,
  TaskChangeDelivery,
  enqueueTaskChangeForRecipient,
  readTaskDeliveries,
} from "./task-delivery";
import * as teams from "./teams";

const createdTeams: string[] = [];
const MESSAGE_MEMBERSHIP_ID = "membership_round3_worker";
const MESSAGE_SESSION_FILE = "/tmp/round3-message-worker.jsonl";

function teamName(suffix: string): string {
  const name = `delivery-r3-${suffix}-${process.pid}-${Date.now()}-${createdTeams.length}`;
  createdTeams.push(name);
  return name;
}

function member(team: string, name: string, sessionFile: string): Member {
  return {
    membershipId: `membership_${name}_${team}`,
    agentId: `${name}@${team}`,
    name,
    agentType: name === "team-lead" ? "lead" : "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile,
    cwd: process.cwd(),
    subscriptions: [],
    isActive: true,
  };
}

function configureTeam(team: string, workerSession: string): TeamConfig {
  const config: TeamConfig = {
    name: team,
    description: "Round 3 delivery evaluator fixture",
    createdAt: Date.now(),
    leadAgentId: "team-lead",
    leadSessionId: "lead-session",
    members: [
      member(team, "team-lead", `/tmp/${team}-lead.jsonl`),
      member(team, "worker", workerSession),
    ],
    taskBackend: "beads",
    taskWorkspace: `/tmp/${team}-declared-workspace`,
    taskAuthorityId: `task_authority_${crypto.randomUUID()}`,
    taskAuthorityFingerprint: { schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: `delivery_${team}`, projectId: `delivery-${team}` },
  };
  fs.mkdirSync(paths.teamDir(team), { recursive: true });
  teams.writeConfigAtomic(paths.configPath(team), config);
  return config;
}

function inboxMessage(id = "message-1"): IdentifiedInboxMessage {
  return {
    id,
    recipientMembershipId: MESSAGE_MEMBERSHIP_ID,
    from: "team-lead",
    text: "full durable body",
    summary: "summary",
    timestamp: "2026-07-15T00:00:00.000Z",
    read: false,
  };
}

function messageContext(details: any) {
  return [{ role: "custom", customType: DIRECT_MESSAGE_CUSTOM_TYPE, details }];
}

function customMessageEntry(batch: any): SessionEntry {
  return {
    type: "custom_message",
    id: `entry-${crypto.randomUUID()}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: batch.customType,
    content: batch.content,
    display: batch.display,
    details: batch.details,
  } as SessionEntry;
}

function ackEntry(customType: string, data: any): SessionEntry {
  return {
    type: "custom",
    id: `entry-${crypto.randomUUID()}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType,
    data,
  } as SessionEntry;
}

function messageHarness(messages = [inboxMessage()]) {
  const sink = { sendMessage: vi.fn(), appendEntry: vi.fn() };
  const markRead = vi.fn(async (ids: Iterable<string>) => [...ids].length);
  const delivery = new DirectMessageDelivery(sink, {
    teamName: "round3-message-team",
    recipient: "worker",
    membershipId: MESSAGE_MEMBERSHIP_ID,
    sessionFile: MESSAGE_SESSION_FILE,
    pollMs: 60_000,
    dependencies: {
      readUnread: vi.fn(async () => messages),
      markRead,
      isCurrentBinding: vi.fn(async () => true),
      watch: vi.fn(() => () => undefined),
    },
  });
  return { delivery, sink, markRead };
}

function taskCard(id: string, assignee = "worker"): TaskCard {
  return {
    id,
    title: "Task delivery",
    goal: "Deliver the canonical Task card.",
    status: "in_progress",
    current_context: "The Task is ready for delivery.",
    assignee,
    version: taskVersionRef(`version-${id}`),
  };
}

function taskDelivery(team: string, sessionFile: string) {
  const sink = { sendMessage: vi.fn(), appendEntry: vi.fn() };
  const delivery = new TaskChangeDelivery(sink, {
    teamName: team,
    recipient: "worker",
    sessionFile,
    pollMs: 60_000,
    reconcile: async () => 0,
  });
  return { delivery, sink };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const team of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(team), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(team), { recursive: true, force: true });
  }
});

describe("Round 3 successful-turn Message acknowledgement", () => {
  it("keeps an error-stopped presented Message unread and replays it on restart", async () => {
    const first = messageHarness();
    await first.delivery.start([]);
    const presented = first.sink.sendMessage.mock.calls[0][0];
    await first.delivery.observeContext(messageContext(presented.details));

    expect(await first.delivery.commitPresentedAfterSuccessfulTurn("error")).toBe(0);
    expect(first.sink.appendEntry).not.toHaveBeenCalled();
    expect(first.markRead).not.toHaveBeenCalled();
    first.delivery.stop();

    const restarted = messageHarness();
    await restarted.delivery.start([customMessageEntry(presented)]);
    expect(restarted.sink.sendMessage).toHaveBeenCalledTimes(1);
    expect(restarted.sink.sendMessage.mock.calls[0][0]).toMatchObject({
      customType: DIRECT_MESSAGE_RESUME_TYPE,
      details: { messageIds: ["message-1"] },
    });
    expect(restarted.markRead).not.toHaveBeenCalled();
    restarted.delivery.stop();
  });

  it("commits one successful turn acknowledgement exactly once", async () => {
    const current = messageHarness();
    await current.delivery.start([]);
    const presented = current.sink.sendMessage.mock.calls[0][0];
    await current.delivery.observeContext(messageContext(presented.details));

    expect(await current.delivery.commitPresentedAfterSuccessfulTurn("stop")).toBe(1);
    expect(await current.delivery.commitPresentedAfterSuccessfulTurn("stop")).toBe(0);
    expect(current.sink.appendEntry).toHaveBeenCalledTimes(1);
    expect(current.sink.appendEntry).toHaveBeenCalledWith(
      DIRECT_MESSAGE_ACK_ENTRY_TYPE,
      expect.objectContaining({ messageIds: ["message-1"] }),
    );
    expect(current.markRead).toHaveBeenCalledTimes(1);
    current.delivery.stop();

    const acknowledged = ackEntry(DIRECT_MESSAGE_ACK_ENTRY_TYPE, current.sink.appendEntry.mock.calls[0][1]);
    const restarted = messageHarness();
    await restarted.delivery.start([customMessageEntry(presented), acknowledged]);
    expect(restarted.sink.sendMessage).not.toHaveBeenCalled();
    expect(restarted.markRead).toHaveBeenCalledTimes(1);
    restarted.delivery.stop();
  });

  it("accepts toolUse as a successful boundary before a later error without double-acking", async () => {
    const current = messageHarness();
    await current.delivery.start([]);
    const presented = current.sink.sendMessage.mock.calls[0][0];
    await current.delivery.observeContext(messageContext(presented.details));

    expect(await current.delivery.commitPresentedAfterSuccessfulTurn("toolUse")).toBe(1);
    expect(await current.delivery.commitPresentedAfterSuccessfulTurn("error")).toBe(0);
    expect(current.sink.appendEntry).toHaveBeenCalledTimes(1);
    expect(current.markRead).toHaveBeenCalledTimes(1);
    current.delivery.stop();
  });

  it("keeps a cancelled presented Message pending", async () => {
    const current = messageHarness();
    await current.delivery.start([]);
    const presented = current.sink.sendMessage.mock.calls[0][0];
    await current.delivery.observeContext(messageContext(presented.details));

    expect(await current.delivery.commitPresentedAfterSuccessfulTurn("aborted")).toBe(0);
    expect(current.sink.appendEntry).not.toHaveBeenCalled();
    expect(current.markRead).not.toHaveBeenCalled();
    current.delivery.stop();
  });
});

describe("Round 3 successful-turn Task acknowledgement", () => {
  it("keeps an error-stopped presented Task change pending and replays it on restart", async () => {
    const team = teamName("task-error");
    const sessionFile = `/tmp/${team}-worker.jsonl`;
    configureTeam(team, sessionFile);
    const record = await enqueueTaskChangeForRecipient(team, taskCard("task-error"), "worker", "assigned");
    expect(record).not.toBeNull();

    const first = taskDelivery(team, sessionFile);
    await first.delivery.start([]);
    const presented = first.sink.sendMessage.mock.calls[0][0];
    await first.delivery.observeContext([{
      role: "custom",
      customType: TASK_CHANGE_CUSTOM_TYPE,
      details: presented.details,
    }]);
    expect(await first.delivery.commitPresentedAfterSuccessfulTurn("error")).toBe(0);
    expect(first.sink.appendEntry).not.toHaveBeenCalled();
    expect((await readTaskDeliveries(team, "worker"))[0].successfulTurnAckAt).toBeUndefined();
    first.delivery.stop();

    const restarted = taskDelivery(team, sessionFile);
    await restarted.delivery.start([customMessageEntry(presented)]);
    expect(restarted.sink.sendMessage).toHaveBeenCalledTimes(1);
    expect(restarted.sink.sendMessage.mock.calls[0][0]).toMatchObject({
      customType: TASK_CHANGE_RESUME_TYPE,
      details: { deliveryIds: [record!.deliveryId] },
    });
    expect((await readTaskDeliveries(team, "worker"))[0].successfulTurnAckAt).toBeUndefined();
    restarted.delivery.stop();
  });

  it("keeps a cancelled presented Task change pending", async () => {
    const team = teamName("task-aborted");
    const sessionFile = `/tmp/${team}-worker.jsonl`;
    configureTeam(team, sessionFile);
    const record = await enqueueTaskChangeForRecipient(team, taskCard("task-aborted"), "worker", "assigned");
    const current = taskDelivery(team, sessionFile);
    await current.delivery.start([]);
    const presented = current.sink.sendMessage.mock.calls[0][0];
    await current.delivery.observeContext([{
      role: "custom",
      customType: TASK_CHANGE_CUSTOM_TYPE,
      details: presented.details,
    }]);

    expect(await current.delivery.commitPresentedAfterSuccessfulTurn("aborted")).toBe(0);
    expect(current.sink.appendEntry).not.toHaveBeenCalled();
    const pending = (await readTaskDeliveries(team, "worker"))[0];
    expect(pending).toMatchObject({ deliveryId: record!.deliveryId });
    expect(pending).not.toHaveProperty("successfulTurnAckAt");
    current.delivery.stop();
  });

  it("retries a failed exact-Session Task presentation with its stable delivery ID", async () => {
    const team = teamName("task-send-failure");
    const sessionFile = `/tmp/${team}-worker.jsonl`;
    configureTeam(team, sessionFile);
    const record = await enqueueTaskChangeForRecipient(team, taskCard("task-send-failure"), "worker", "assigned");
    const failed = new TaskChangeDelivery({
      sendMessage: vi.fn(() => { throw new Error("injected Session delivery failure"); }),
      appendEntry: vi.fn(),
    }, { teamName: team, recipient: "worker", sessionFile, pollMs: 60_000, reconcile: async () => 0 });

    await expect(failed.start([])).rejects.toThrow("injected Session delivery failure");
    failed.stop();
    const pending = (await readTaskDeliveries(team, "worker"))[0];
    expect(pending).toMatchObject({ deliveryId: record!.deliveryId });
    expect(pending).not.toHaveProperty("successfulTurnAckAt");

    const retried = taskDelivery(team, sessionFile);
    await retried.delivery.start([]);
    expect(retried.sink.sendMessage).toHaveBeenCalledTimes(1);
    expect(retried.sink.sendMessage.mock.calls[0][0].details.deliveryIds).toEqual([record!.deliveryId]);
    retried.delivery.stop();
  });

  it("commits successful Task delivery exactly once, including toolUse before later error", async () => {
    const team = teamName("task-success");
    const sessionFile = `/tmp/${team}-worker.jsonl`;
    configureTeam(team, sessionFile);
    const record = await enqueueTaskChangeForRecipient(team, taskCard("task-success"), "worker", "assigned");
    const current = taskDelivery(team, sessionFile);
    await current.delivery.start([]);
    const presented = current.sink.sendMessage.mock.calls[0][0];
    await current.delivery.observeContext([{
      role: "custom",
      customType: TASK_CHANGE_CUSTOM_TYPE,
      details: presented.details,
    }]);

    expect(await current.delivery.commitPresentedAfterSuccessfulTurn("toolUse")).toBe(1);
    expect(await current.delivery.commitPresentedAfterSuccessfulTurn("error")).toBe(0);
    expect(current.sink.appendEntry).toHaveBeenCalledTimes(1);
    expect(current.sink.appendEntry).toHaveBeenCalledWith(
      TASK_CHANGE_ACK_ENTRY_TYPE,
      expect.objectContaining({ deliveryIds: [record!.deliveryId] }),
    );
    expect((await readTaskDeliveries(team, "worker"))[0].successfulTurnAckAt).toEqual(expect.any(String));
    current.delivery.stop();
  });
});
