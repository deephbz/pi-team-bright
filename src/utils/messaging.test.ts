import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

const lockControl = vi.hoisted(() => ({
  handler: undefined as undefined | (<T>(lockPath: string, fn: () => Promise<T>) => Promise<T>),
}));

vi.mock("./lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lock")>();
  return {
    ...actual,
    withLock: <T>(lockPath: string, fn: () => Promise<T>, retries?: number): Promise<T> => (
      lockControl.handler ? lockControl.handler(lockPath, fn) : actual.withLock(lockPath, fn, retries)
    ),
  };
});
import path from "node:path";
import os from "node:os";
import {
  appendMessage,
  readInbox,
  readInboxForMembership,
  sendPlainMessage,
  broadcastMessage,
  markMessagesRead,
  markMessagesReadForMembership,
  RecipientNotCurrentMemberError,
} from "./messaging";
import * as paths from "./paths";

// Mock the paths to use a temporary directory
const testDir = path.join(os.tmpdir(), "pi-teams-test-" + Date.now());

describe("Messaging Utilities", () => {
  beforeEach(() => {
    lockControl.handler = undefined;
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
    
    // Override paths to use testDir
    vi.spyOn(paths, "inboxPath").mockImplementation((teamName, agentName) => {
      return path.join(testDir, "inboxes", `${agentName}.json`);
    });
    vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
    vi.spyOn(paths, "configPath").mockImplementation((teamName) => {
      return path.join(testDir, "config.json");
    });
    fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify({
      name: "test-team",
      members: [
        { name: "sender", membershipId: "membership_sender" },
        { name: "receiver", membershipId: "membership_receiver" },
      ],
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("should append a message successfully", async () => {
    const msg = { from: "sender", text: "hello", timestamp: "now", read: false };
    await appendMessage("test-team", "receiver", msg);
    
    const inbox = await readInbox("test-team", "receiver", false, false);
    expect(inbox.length).toBe(1);
    expect(inbox[0].text).toBe("hello");
    expect(inbox[0].id).toMatch(/^message_/);
  });

  it("should persist deterministic IDs for legacy records", async () => {
    const inboxFile = path.join(testDir, "inboxes", "receiver.json");
    fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
    fs.writeFileSync(inboxFile, JSON.stringify([{
      from: "sender",
      text: "legacy body",
      timestamp: "2026-01-01T00:00:00.000Z",
      read: false,
    }]));

    const first = await readInbox("test-team", "receiver", true, false);
    const second = await readInbox("test-team", "receiver", true, false);
    expect(first[0].id).toMatch(/^legacy_/);
    expect(second[0].id).toBe(first[0].id);
    expect(JSON.parse(fs.readFileSync(inboxFile, "utf8"))[0].id).toBe(first[0].id);
  });

  it("should handle concurrent appends (Stress Test)", async () => {
    const numMessages = 100;
    const promises = [];
    for (let i = 0; i < numMessages; i++) {
      promises.push(sendPlainMessage("test-team", `sender-${i}`, "receiver", `msg-${i}`, `summary-${i}`));
    }
    
    await Promise.all(promises);
    
    const inbox = await readInbox("test-team", "receiver", false, false);
    expect(inbox.length).toBe(numMessages);
    
    // Verify all messages are present
    const texts = inbox.map(m => m.text).sort();
    for (let i = 0; i < numMessages; i++) {
      expect(texts).toContain(`msg-${i}`);
    }
  }, 30_000);

  it("rejects a direct message to an address absent from the current roster", async () => {
    await expect(sendPlainMessage("test-team", "sender", "former-member", "body", "summary"))
      .rejects.toEqual(expect.objectContaining<Partial<RecipientNotCurrentMemberError>>({
        name: "RecipientNotCurrentMemberError",
        teamName: "test-team",
        recipient: "former-member",
      }));
    expect(fs.existsSync(path.join(testDir, "inboxes", "former-member.json"))).toBe(false);
  });

  it("stamps exact sender and recipient membership generations", async () => {
    const accepted = await sendPlainMessage("test-team", "sender", "receiver", "body", "summary");
    expect(accepted).toMatchObject({
      senderMembershipId: "membership_sender",
      recipientMembershipId: "membership_receiver",
    });
  });

  it("rejects a stale sender binding at the Message append boundary", async () => {
    const configFile = path.join(testDir, "config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    config.members[0].sessionFile = "/tmp/current-sender.jsonl";
    fs.writeFileSync(configFile, JSON.stringify(config));

    await expect(sendPlainMessage(
      "test-team",
      "sender",
      "receiver",
      "stale body",
      "stale",
      undefined,
      { membershipId: "membership_sender", sessionFile: "/tmp/stale-sender.jsonl" },
    )).rejects.toThrow(/refusing a stale Message append/);
    expect(fs.existsSync(path.join(testDir, "inboxes", "receiver.json"))).toBe(false);
  });

  it("keeps historical generations queryable while current reads and acks stay exact", async () => {
    const inboxFile = path.join(testDir, "inboxes", "receiver.json");
    fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
    fs.writeFileSync(inboxFile, JSON.stringify([
      {
        id: "message_old",
        recipientMembershipId: "membership_old",
        from: "sender",
        text: "old generation",
        timestamp: "2026-01-01T00:00:00.000Z",
        read: false,
      },
      {
        id: "message_legacy",
        from: "sender",
        text: "unscoped legacy evidence",
        timestamp: "2026-01-01T00:00:01.000Z",
        read: false,
      },
    ]));
    const current = await sendPlainMessage("test-team", "sender", "receiver", "current generation", "current");

    expect((await readInbox("test-team", "receiver", false, false)).map((message) => message.id))
      .toEqual(["message_old", "message_legacy", current.id]);
    expect((await readInboxForMembership(
      "test-team",
      "receiver",
      "membership_receiver",
      true,
      false,
    )).map((message) => message.id)).toEqual([current.id]);

    expect(await markMessagesReadForMembership(
      "test-team",
      "receiver",
      "membership_receiver",
      ["message_old", "message_legacy", current.id],
    )).toBe(1);
    const all = await readInbox("test-team", "receiver", false, false);
    expect(all.find((message) => message.id === "message_old")?.read).toBe(false);
    expect(all.find((message) => message.id === "message_legacy")?.read).toBe(false);
    expect(all.find((message) => message.id === current.id)?.read).toBe(true);
  });

  it("should mark messages as read", async () => {
    await sendPlainMessage("test-team", "sender", "receiver", "msg1", "summary1");
    await sendPlainMessage("test-team", "sender", "receiver", "msg2", "summary2");
    
    // Read only unread messages
    const unread = await readInbox("test-team", "receiver", true, true);
    expect(unread.length).toBe(2);
    
    // Now all should be read
    const all = await readInbox("test-team", "receiver", false, false);
    expect(all.length).toBe(2);
    expect(all.every(m => m.read)).toBe(true);
  });

  it("should acknowledge only explicitly selected Message IDs", async () => {
    const first = await sendPlainMessage("test-team", "sender", "receiver", "msg1", "summary1");
    const second = await sendPlainMessage("test-team", "sender", "receiver", "msg2", "summary2");

    expect(await markMessagesRead("test-team", "receiver", [second.id])).toBe(1);
    const all = await readInbox("test-team", "receiver", false, false);
    expect(all.find(message => message.id === first.id)?.read).toBe(false);
    expect(all.find(message => message.id === second.id)?.read).toBe(true);
  });

  it("should broadcast message to all members except the sender", async () => {
    // Setup team config
    const config = {
      name: "test-team",
      members: [
        { name: "sender", membershipId: "membership_sender" },
        { name: "member1", membershipId: "membership_member1" },
        { name: "member2", membershipId: "membership_member2" }
      ]
    };
    const configFilePath = path.join(testDir, "config.json");
    fs.writeFileSync(configFilePath, JSON.stringify(config));
    
    const result = await broadcastMessage("test-team", "sender", "broadcast text", "summary");
    expect(result.failures).toEqual([]);
    expect(result.accepted).toEqual([
      { recipient: "member1", messageId: expect.stringMatching(/^message_/) },
      { recipient: "member2", messageId: expect.stringMatching(/^message_/) },
    ]);

    // Check member1's inbox
    const inbox1 = await readInbox("test-team", "member1", false, false);
    expect(inbox1.length).toBe(1);
    expect(inbox1[0].text).toBe("broadcast text");
    expect(inbox1[0].from).toBe("sender");

    // Check member2's inbox
    const inbox2 = await readInbox("test-team", "member2", false, false);
    expect(inbox2.length).toBe(1);
    expect(inbox2[0].text).toBe("broadcast text");
    expect(inbox2[0].from).toBe("sender");

    // Check sender's inbox (should be empty)
    const inboxSender = await readInbox("test-team", "sender", false, false);
    expect(inboxSender.length).toBe(0);
  });

  it("starts every current-roster delivery before it settles and retains roster receipt order", async () => {
    fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify({
      name: "test-team",
      members: [
        { name: "sender", membershipId: "membership_sender" },
        { name: "worker-a", membershipId: "membership_a" },
        { name: "worker-b", membershipId: "membership_b" },
        { name: "worker-c", membershipId: "membership_c" },
      ],
    }));

    const started: string[] = [];
    const gates = new Map<string, { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }>();
    let resolveAllStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => { resolveAllStarted = resolve; });
    for (const recipient of ["worker-a", "worker-b", "worker-c"]) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      gates.set(recipient, { promise, resolve, reject });
    }
    lockControl.handler = async <T>(lockPath: string, fn: () => Promise<T>): Promise<T> => {
      const delivery = await fn();
      const recipient = path.basename(lockPath, ".json");
      const gate = gates.get(recipient);
      if (!gate) return delivery;
      started.push(recipient);
      if (started.length === 3) resolveAllStarted();
      await gate.promise;
      return delivery;
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const resultPromise = broadcastMessage("test-team", "sender", "broadcast text", "summary");
    await allStarted;
    expect(started).toEqual(["worker-a", "worker-b", "worker-c"]);

    gates.get("worker-c")!.reject(new Error("worker-c delivery failed"));
    gates.get("worker-b")!.resolve();
    gates.get("worker-a")!.reject(new Error("worker-a delivery failed"));

    await expect(resultPromise).resolves.toEqual({
      accepted: [
        { recipient: "worker-b", messageId: expect.stringMatching(/^message_/) },
      ],
      failures: [
        { recipient: "worker-a", error: "worker-a delivery failed" },
        { recipient: "worker-c", error: "worker-c delivery failed" },
      ],
    });
    expect(error).toHaveBeenNthCalledWith(1, "Broadcast partially failed: 2 messages could not be delivered.");
    expect(error).toHaveBeenNthCalledWith(2, "- worker-a: worker-a delivery failed");
    expect(error).toHaveBeenNthCalledWith(3, "- worker-c: worker-c delivery failed");
  });

  it("returns accepted Message IDs and recipient-specific partial failures", async () => {
    fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify({
      name: "test-team",
      members: [
        { name: "sender", membershipId: "membership_sender" },
        { name: "accepted", membershipId: "membership_accepted" },
        { name: "broken", membershipId: "membership_broken" },
      ],
    }));
    const brokenPath = path.join(testDir, "inboxes", "broken.json");
    fs.mkdirSync(brokenPath, { recursive: true });

    const result = await broadcastMessage("test-team", "sender", "broadcast text", "summary");

    expect(result.accepted).toEqual([
      { recipient: "accepted", messageId: expect.stringMatching(/^message_/) },
    ]);
    expect(result.failures).toEqual([
      { recipient: "broken", error: expect.stringMatching(/EISDIR|directory/i) },
    ]);
    expect(await readInbox("test-team", "accepted", false, false)).toHaveLength(1);
  });
});
