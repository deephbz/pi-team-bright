import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { IdentifiedInboxMessage } from "./models";
import {
  DEFAULT_MESSAGE_POLL_MS,
  DIRECT_MESSAGE_CUSTOM_TYPE,
  DIRECT_MESSAGE_OBSERVED_ENTRY_TYPE,
  DIRECT_MESSAGE_RESUME_TYPE,
  DirectMessageDelivery,
  directMessageDeliveryEnabled,
  messagePollMs,
  observedMessageIdsFromEntries,
} from "./message-delivery";

function inboxMessage(id: string, text: string): IdentifiedInboxMessage {
  return {
    id,
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
      schemaVersion: 1,
      teamName: "alpha",
      recipient: "worker",
      messageIds,
    },
  };
}

function observedEntry(messageIds: string[]): SessionEntry {
  return {
    type: "custom",
    id: "observation-entry",
    parentId: null,
    timestamp: "2026-07-14T00:00:01.000Z",
    customType: DIRECT_MESSAGE_OBSERVED_ENTRY_TYPE,
    data: {
      authority: "pi-teams-message",
      schemaVersion: 1,
      teamName: "alpha",
      recipient: "worker",
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
    pollMs: 60_000,
    dependencies: {
      readUnread: vi.fn(async () => unread),
      markRead,
      watch: vi.fn(() => () => undefined),
    },
  });
  return { delivery, markRead, markedCalls, sink };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("direct Message delivery configuration", () => {
  it("is opt-in and keeps a safe fallback poll interval", () => {
    expect(directMessageDeliveryEnabled({})).toBe(false);
    expect(directMessageDeliveryEnabled({ PI_TEAMS_MESSAGE_DELIVERY: "steer" })).toBe(true);
    expect(directMessageDeliveryEnabled({ PI_TEAMS_MESSAGE_DELIVERY: "legacy" })).toBe(false);
    expect(messagePollMs({})).toBe(DEFAULT_MESSAGE_POLL_MS);
    expect(messagePollMs({ PI_TEAMS_MESSAGE_POLL_MS: "25" })).toBe(25);
    expect(messagePollMs({ PI_TEAMS_MESSAGE_POLL_MS: "0" })).toBe(DEFAULT_MESSAGE_POLL_MS);
  });
});

describe("DirectMessageDelivery", () => {
  it("coalesces full unread Message bodies into one custom steer and acks only from context", async () => {
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

    expect(sink.appendEntry).toHaveBeenCalledWith(
      DIRECT_MESSAGE_OBSERVED_ENTRY_TYPE,
      expect.objectContaining({ messageIds: ["message_1", "message_2"] }),
    );
    expect(sink.appendEntry).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markedCalls[0]).toEqual(["message_1", "message_2"]);
    delivery.stop();
  });

  it("does not present the same logical Message twice during one process", async () => {
    const { delivery, sink } = harness([inboxMessage("message_1", "one body")]);
    await delivery.start([]);
    await delivery.scan();
    await delivery.scan();
    expect(sink.sendMessage).toHaveBeenCalledTimes(1);
    delivery.stop();
  });

  it("rehydrates durable context observations and marks only those IDs read", async () => {
    const { delivery, markedCalls, sink } = harness([inboxMessage("message_1", "already observed")]);
    await delivery.start([observedEntry(["message_1"])]);

    expect(observedMessageIdsFromEntries(
      [observedEntry(["message_1"])],
      "alpha",
      "worker",
    )).toEqual(new Set(["message_1"]));
    expect(markedCalls[0]).toEqual(["message_1"]);
    expect(sink.sendMessage).not.toHaveBeenCalled();
    delivery.stop();
  });

  it("does not treat a persisted custom Message as context-observed across the fault cut", async () => {
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
        schemaVersion: 1,
        teamName: "alpha",
        recipient: "other-worker",
        messageIds: ["message_1"],
      },
    }]);
    expect(markRead).not.toHaveBeenCalled();
    delivery.stop();
  });
});
