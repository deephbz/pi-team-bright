import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { IdentifiedInboxMessage } from "./models";
import {
  DEFAULT_MESSAGE_POLL_MS,
  DIRECT_MESSAGE_CUSTOM_TYPE,
  DIRECT_MESSAGE_ACK_ENTRY_TYPE,
  DIRECT_MESSAGE_RESUME_TYPE,
  DirectMessageDelivery,
  messagePollMs,
  acknowledgedMessageIdsFromEntries,
} from "./message-delivery";

const MEMBERSHIP_ID = "membership_worker_current";
const SESSION_FILE = "/sessions/worker-current.jsonl";

function inboxMessage(id: string, text: string): IdentifiedInboxMessage {
  return {
    id,
    recipientMembershipId: MEMBERSHIP_ID,
    from: "team-lead",
    text,
    summary: `summary ${id}`,
    timestamp: "2026-07-14T00:00:00.000Z",
    read: false,
  };
}

function customMessageEntry(messageIds: string[]): SessionEntry {
  return {
    type: "custom_message",
    id: "custom-entry",
    parentId: null,
    timestamp: "2026-07-14T00:00:00.000Z",
    customType: DIRECT_MESSAGE_CUSTOM_TYPE,
    content: "full canonical bodies",
    display: true,
    details: {
      authority: "pi-teams-message",
      schemaVersion: 2,
      teamName: "alpha",
      recipient: "worker",
      recipientMembershipId: MEMBERSHIP_ID,
      recipientSessionFile: SESSION_FILE,
      messageIds,
    },
  };
}

function acknowledgedEntry(messageIds: string[]): SessionEntry {
  return {
    type: "custom",
    id: "observation-entry",
    parentId: null,
    timestamp: "2026-07-14T00:00:01.000Z",
    customType: DIRECT_MESSAGE_ACK_ENTRY_TYPE,
    data: {
      authority: "pi-teams-message",
      schemaVersion: 2,
      teamName: "alpha",
      recipient: "worker",
      recipientMembershipId: MEMBERSHIP_ID,
      recipientSessionFile: SESSION_FILE,
      messageIds,
    },
  };
}

function harness(unread: IdentifiedInboxMessage[]) {
  const sink = {
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
  const markedCalls: string[][] = [];
  const markRead = vi.fn(async (ids: Iterable<string>) => {
    markedCalls.push([...ids]);
    return 0;
  });
  const delivery = new DirectMessageDelivery(sink, {
    teamName: "alpha",
    recipient: "worker",
    membershipId: MEMBERSHIP_ID,
    sessionFile: SESSION_FILE,
    pollMs: 60_000,
    dependencies: {
      readUnread: vi.fn(async () => unread),
      markRead,
      isCurrentBinding: vi.fn(async () => true),
      watch: vi.fn(() => () => undefined),
    },
  });
  return { delivery, markRead, markedCalls, sink };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("direct Message delivery configuration", () => {
  it("keeps only a safe internal fallback rescan interval", () => {
    expect(messagePollMs({})).toBe(DEFAULT_MESSAGE_POLL_MS);
    expect(messagePollMs({ PI_TEAMS_MESSAGE_POLL_MS: "25" })).toBe(25);
    expect(messagePollMs({ PI_TEAMS_MESSAGE_POLL_MS: "0" })).toBe(DEFAULT_MESSAGE_POLL_MS);
  });
});

describe("DirectMessageDelivery", () => {
  it("stages from context and acknowledges only after a successful turn", async () => {
    const messages = [inboxMessage("message_1", "first full body"), inboxMessage("message_2", "second full body")];
    const { delivery, markRead, markedCalls, sink } = harness(messages);

    await delivery.start([]);

    expect(sink.sendMessage).toHaveBeenCalledTimes(1);
    const [batch, options] = sink.sendMessage.mock.calls[0];
    expect(batch).toMatchObject({
      customType: DIRECT_MESSAGE_CUSTOM_TYPE,
      details: { messageIds: ["message_1", "message_2"] },
    });
    expect(batch.content).toContain("first full body");
    expect(batch.content).toContain("second full body");
    expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(markRead).not.toHaveBeenCalled();

    await delivery.observeContext([{
      role: "custom",
      customType: batch.customType,
      details: batch.details,
    }]);
    await delivery.observeContext([{
      role: "custom",
      customType: batch.customType,
      details: batch.details,
    }]);
    expect(markRead).not.toHaveBeenCalled();
    expect(sink.appendEntry).not.toHaveBeenCalled();
    await delivery.commitPresentedAfterSuccessfulTurn("toolUse");
    await delivery.commitPresentedAfterSuccessfulTurn("error");

    expect(sink.appendEntry).toHaveBeenCalledWith(
      DIRECT_MESSAGE_ACK_ENTRY_TYPE,
      expect.objectContaining({ messageIds: ["message_1", "message_2"] }),
    );
    expect(sink.appendEntry).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markedCalls[0]).toEqual(["message_1", "message_2"]);
    delivery.stop();
  });

  it("replays context-staged Messages after error restart but not after successful-turn ack", async () => {
    const message = inboxMessage("message_1", "survives transport failure");
    const first = harness([message]);
    await first.delivery.start([]);
    const batch = first.sink.sendMessage.mock.calls[0][0];
    await first.delivery.observeContext([{ role: "custom", customType: batch.customType, details: batch.details }]);
    await first.delivery.commitPresentedAfterSuccessfulTurn("error");
    expect(first.markRead).not.toHaveBeenCalled();
    expect(first.sink.appendEntry).not.toHaveBeenCalled();
    first.delivery.stop();

    const retry = harness([message]);
    const presented = customMessageEntry([message.id]);
    await retry.delivery.start([presented]);
    expect(retry.sink.sendMessage.mock.calls[0][0].customType).toBe(DIRECT_MESSAGE_RESUME_TYPE);
    const custom = presented as Extract<SessionEntry, { type: "custom_message" }>;
    await retry.delivery.observeContext([{ role: "custom", customType: custom.customType, details: custom.details }]);
    await retry.delivery.commitPresentedAfterSuccessfulTurn("toolUse");
    await retry.delivery.commitPresentedAfterSuccessfulTurn("error");
    expect(retry.sink.appendEntry).toHaveBeenCalledTimes(1);
    retry.delivery.stop();

    const settled = harness([message]);
    await settled.delivery.start([presented, acknowledgedEntry([message.id])]);
    expect(settled.sink.sendMessage).not.toHaveBeenCalled();
    settled.delivery.stop();
  });

  it("does not present the same logical Message twice during one process", async () => {
    const { delivery, sink } = harness([inboxMessage("message_1", "one body")]);
    await delivery.start([]);
    await delivery.scan();
    await delivery.scan();
    expect(sink.sendMessage).toHaveBeenCalledTimes(1);
    delivery.stop();
  });

  it("rehydrates durable successful-turn acknowledgements and marks only those IDs read", async () => {
    const { delivery, markedCalls, sink } = harness([inboxMessage("message_1", "already observed")]);
    await delivery.start([acknowledgedEntry(["message_1"])]);

    expect(acknowledgedMessageIdsFromEntries(
      [acknowledgedEntry(["message_1"])],
      "alpha",
      "worker",
      MEMBERSHIP_ID,
      SESSION_FILE,
    )).toEqual(new Set(["message_1"]));
    expect(markedCalls[0]).toEqual(["message_1"]);
    expect(sink.sendMessage).not.toHaveBeenCalled();
    delivery.stop();
  });

  it("replays a presented Message after an errored turn and settles after success", async () => {
    const { delivery, markRead, markedCalls, sink } = harness([inboxMessage("message_1", "full canonical body")]);
    const persistedBeforeContext = customMessageEntry(["message_1"]);

    await delivery.start([persistedBeforeContext]);

    expect(markRead).not.toHaveBeenCalled();
    expect(sink.sendMessage).toHaveBeenCalledTimes(1);
    expect(sink.sendMessage.mock.calls[0][0]).toMatchObject({
      customType: DIRECT_MESSAGE_RESUME_TYPE,
      details: { messageIds: ["message_1"] },
    });
    expect(sink.sendMessage.mock.calls[0][0].content).not.toContain("full canonical body");

    const custom = persistedBeforeContext as Extract<SessionEntry, { type: "custom_message" }>;
    await delivery.observeContext([{
      role: "custom",
      customType: custom.customType,
      details: custom.details,
    }]);
    await delivery.commitPresentedAfterSuccessfulTurn("error");
    expect(markRead).not.toHaveBeenCalled();
    await delivery.commitPresentedAfterSuccessfulTurn("stop");
    expect(markedCalls[0]).toEqual(["message_1"]);
    delivery.stop();
  });

  it("ignores observations belonging to another authority-local recipient", async () => {
    const { delivery, markRead } = harness([]);
    await delivery.start([]);
    await delivery.observeContext([{
      role: "custom",
      customType: DIRECT_MESSAGE_CUSTOM_TYPE,
      details: {
        authority: "pi-teams-message",
        schemaVersion: 2,
        teamName: "alpha",
        recipient: "other-worker",
        recipientMembershipId: "membership_other",
        recipientSessionFile: "/sessions/other.jsonl",
        messageIds: ["message_1"],
      },
    }]);
    expect(markRead).not.toHaveBeenCalled();
    delivery.stop();
  });

  it("never presents or acknowledges another generation or an unscoped legacy record", async () => {
    const current = inboxMessage("message_current", "current");
    const old = {
      ...inboxMessage("message_old", "old"),
      recipientMembershipId: "membership_worker_old",
    };
    const legacy = {
      ...inboxMessage("message_legacy", "legacy"),
      recipientMembershipId: undefined,
    };
    const { delivery, markRead, sink } = harness([old, legacy, current]);
    await delivery.start([]);

    expect(sink.sendMessage).toHaveBeenCalledTimes(1);
    expect(sink.sendMessage.mock.calls[0][0]).toMatchObject({
      details: {
        recipientMembershipId: MEMBERSHIP_ID,
        recipientSessionFile: SESSION_FILE,
        messageIds: ["message_current"],
      },
    });
    expect(sink.sendMessage.mock.calls[0][0].content).not.toContain("old");
    expect(sink.sendMessage.mock.calls[0][0].content).not.toContain("legacy");
    await delivery.observeContext([{
      role: "custom",
      customType: DIRECT_MESSAGE_CUSTOM_TYPE,
      details: {
        authority: "pi-teams-message",
        schemaVersion: 2,
        teamName: "alpha",
        recipient: "worker",
        recipientMembershipId: "membership_worker_old",
        recipientSessionFile: "/sessions/worker-old.jsonl",
        messageIds: ["message_old"],
      },
    }]);
    await delivery.commitPresentedAfterSuccessfulTurn("stop");
    expect(markRead).not.toHaveBeenCalled();
    delivery.stop();
  });

  it("stops a replaced old process before it can deliver a new generation payload", async () => {
    const sink = { sendMessage: vi.fn(), appendEntry: vi.fn() };
    const delivery = new DirectMessageDelivery(sink, {
      teamName: "alpha",
      recipient: "worker",
      membershipId: "membership_worker_old",
      sessionFile: "/sessions/worker-old.jsonl",
      dependencies: {
        readUnread: vi.fn(async () => [inboxMessage("message_current", "new generation")]),
        markRead: vi.fn(async () => 0),
        isCurrentBinding: vi.fn(async () => false),
        watch: vi.fn(() => () => undefined),
      },
    });
    await delivery.start([]);
    expect(sink.sendMessage).not.toHaveBeenCalled();
  });
});
