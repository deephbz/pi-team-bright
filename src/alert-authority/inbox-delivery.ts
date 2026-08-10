import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { IdentifiedInboxMessage, InboxMessage } from "./delivery-contracts";
import type { BroadcastMessageResult, ExpectedSenderBinding } from "./contracts";

export type { BroadcastMessageResult, ExpectedSenderBinding } from "./contracts";
import { withLock } from "../utils/lock";
import { inboxPath } from "../utils/paths";
import { readConfig, teamExists, withCurrentConfig } from "../utils/teams";
import { writeJsonAtomic } from "../utils/atomic-json";

export class MessageTeamDoesNotExistError extends Error {
  constructor(readonly teamName: string) {
    super(`Team '${teamName}' does not exist.`);
    this.name = "MessageTeamDoesNotExistError";
  }
}

export class RecipientNotCurrentMemberError extends Error {
  constructor(
    readonly teamName: string,
    readonly recipient: string,
  ) {
    super(`Recipient '${recipient}' is not a current member of team '${teamName}'.`);
    this.name = "RecipientNotCurrentMemberError";
  }
}

export class RecipientMembershipUnresolvedError extends Error {
  constructor(
    readonly teamName: string,
    readonly recipient: string,
  ) {
    super(`Current recipient '${recipient}' in team '${teamName}' has no membership identity.`);
    this.name = "RecipientMembershipUnresolvedError";
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

function newMessageId(): string {
  return `message_${randomUUID()}`;
}

function legacyMessageId(
  teamName: string,
  agentName: string,
  message: InboxMessage,
  index: number,
): string {
  const identity = JSON.stringify({
    teamName,
    agentName,
    index,
    from: message.from,
    text: message.text,
    timestamp: message.timestamp,
    summary: message.summary,
    color: message.color,
  });
  return `legacy_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function identifyMessages(
  teamName: string,
  agentName: string,
  messages: InboxMessage[],
): { messages: IdentifiedInboxMessage[]; changed: boolean } {
  let changed = false;
  const identified = messages.map((message, index) => {
    if (message.id) return message as IdentifiedInboxMessage;
    changed = true;
    return { ...message, id: legacyMessageId(teamName, agentName, message, index) };
  });
  return { messages: identified, changed };
}

export async function appendMessage(
  teamName: string,
  agentName: string,
  message: InboxMessage,
): Promise<IdentifiedInboxMessage> {
  const p = inboxPath(teamName, agentName);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  return await withLock(p, async () => {
    let msgs: InboxMessage[] = [];
    if (fs.existsSync(p)) {
      msgs = JSON.parse(fs.readFileSync(p, "utf-8"));
    }
    const identifiedMessage: IdentifiedInboxMessage = {
      ...message,
      id: message.id || newMessageId(),
    };
    msgs.push(identifiedMessage);
    writeJsonAtomic(p, msgs);
    return identifiedMessage;
  });
}

export async function readInbox(
  teamName: string,
  agentName: string,
  unreadOnly = false,
  markAsRead = true
): Promise<IdentifiedInboxMessage[]> {
  const p = inboxPath(teamName, agentName);
  if (!fs.existsSync(p)) return [];

  return await withLock(p, async () => {
    const rawMessages: InboxMessage[] = JSON.parse(fs.readFileSync(p, "utf-8"));
    const identified = identifyMessages(teamName, agentName, rawMessages);
    const allMsgs = identified.messages;
    let result = allMsgs;

    if (unreadOnly) {
      result = allMsgs.filter(m => !m.read);
    }

    let changed = identified.changed;
    if (markAsRead && result.length > 0) {
      for (const m of allMsgs) {
        if (result.includes(m)) {
          m.read = true;
          changed = true;
        }
      }
    }

    if (changed) {
      writeJsonAtomic(p, allMsgs);
    }

    return result;
  });
}

/**
 * Read only records addressed to one exact membership generation.
 * Legacy unscoped records remain available through readInbox for historical
 * inspection, but are never interpreted as live work for a current member.
 */
export async function readInboxForMembership(
  teamName: string,
  agentName: string,
  membershipId: string,
  unreadOnly = false,
  markAsRead = true,
): Promise<IdentifiedInboxMessage[]> {
  const p = inboxPath(teamName, agentName);
  if (!fs.existsSync(p)) return [];

  return await withLock(p, async () => {
    const rawMessages: InboxMessage[] = JSON.parse(fs.readFileSync(p, "utf-8"));
    const identified = identifyMessages(teamName, agentName, rawMessages);
    const addressed = identified.messages.filter(
      (message) => message.recipientMembershipId === membershipId,
    );
    const result = unreadOnly ? addressed.filter((message) => !message.read) : addressed;
    let changed = identified.changed;
    if (markAsRead && result.length > 0) {
      const selected = new Set(result.map((message) => message.id));
      for (const message of identified.messages) {
        if (
          message.recipientMembershipId === membershipId
          && selected.has(message.id)
          && !message.read
        ) {
          message.read = true;
          changed = true;
        }
      }
    }
    if (changed) writeJsonAtomic(p, identified.messages);
    return result;
  });
}

/** Mark only Messages observed in Pi model context as read. */
export async function markMessagesRead(
  teamName: string,
  agentName: string,
  messageIds: Iterable<string>,
): Promise<number> {
  const p = inboxPath(teamName, agentName);
  if (!fs.existsSync(p)) return 0;
  const ids = new Set(messageIds);
  if (ids.size === 0) return 0;

  return await withLock(p, async () => {
    const rawMessages: InboxMessage[] = JSON.parse(fs.readFileSync(p, "utf-8"));
    const identified = identifyMessages(teamName, agentName, rawMessages);
    let marked = 0;
    for (const message of identified.messages) {
      if (ids.has(message.id) && !message.read) {
        message.read = true;
        marked += 1;
      }
    }
    if (identified.changed || marked > 0) {
      writeJsonAtomic(p, identified.messages);
    }
    return marked;
  });
}

/** Acknowledge IDs only when they belong to the exact recipient generation. */
export async function markMessagesReadForMembership(
  teamName: string,
  agentName: string,
  membershipId: string,
  messageIds: Iterable<string>,
): Promise<number> {
  const p = inboxPath(teamName, agentName);
  if (!fs.existsSync(p)) return 0;
  const ids = new Set(messageIds);
  if (ids.size === 0) return 0;

  return await withLock(p, async () => {
    const rawMessages: InboxMessage[] = JSON.parse(fs.readFileSync(p, "utf-8"));
    const identified = identifyMessages(teamName, agentName, rawMessages);
    let marked = 0;
    for (const message of identified.messages) {
      if (
        message.recipientMembershipId === membershipId
        && ids.has(message.id)
        && !message.read
      ) {
        message.read = true;
        marked += 1;
      }
    }
    if (identified.changed || marked > 0) writeJsonAtomic(p, identified.messages);
    return marked;
  });
}

export async function sendPlainMessage(
  teamName: string,
  fromName: string,
  toName: string,
  text: string,
  summary: string,
  color?: string,
  expectedSender?: ExpectedSenderBinding,
): Promise<IdentifiedInboxMessage> {
  if (!teamExists(teamName)) throw new MessageTeamDoesNotExistError(teamName);
  return withCurrentConfig(teamName, async (config) => {
    const recipient = [...config.members].reverse().find(
      (member) => member.name === toName && member.isActive !== false,
    );
    if (!recipient) {
      throw new RecipientNotCurrentMemberError(teamName, toName);
    }
    if (!recipient.membershipId) {
      throw new RecipientMembershipUnresolvedError(teamName, toName);
    }
    const sender = [...config.members].reverse().find(
      (member) => member.name === fromName && member.isActive !== false,
    );
    if (expectedSender && (
      !sender
      || sender.membershipId !== expectedSender.membershipId
      || sender.sessionFile !== expectedSender.sessionFile
    )) {
      throw new Error(`Sender ${fromName} is no longer bound to Membership ${expectedSender.membershipId} / Session ${expectedSender.sessionFile}; refusing a stale Message append.`);
    }
    const msg: InboxMessage = {
      recipientMembershipId: recipient.membershipId,
      ...(sender?.membershipId ? { senderMembershipId: sender.membershipId } : {}),
      from: fromName,
      text,
      timestamp: nowIso(),
      read: false,
      summary,
      color,
    };
    return appendMessage(teamName, toName, msg);
  });
}

/**
 * Broadcasts a message to all team members except the sender.
 * @param teamName The name of the team
 * @param fromName The name of the sender
 * @param text The message text
 * @param summary A short summary of the message
 * @param color An optional color for the message
 */
export async function broadcastMessage(
  teamName: string,
  fromName: string,
  text: string,
  summary: string,
  color?: string,
  expectedSender?: ExpectedSenderBinding,
): Promise<BroadcastMessageResult> {
  const config = await readConfig(teamName);
  const recipients = config.members
    .filter((member) => member.isActive !== false && member.name !== fromName)
    .map((member) => member.name);

  const deliveryPromises = recipients
    .map((recipient) => sendPlainMessage(teamName, fromName, recipient, text, summary, color, expectedSender));

  // Execute deliveries in parallel and wait for all to settle
  const results = await Promise.allSettled(deliveryPromises);

  // Log failures for diagnostics
  const accepted: BroadcastMessageResult["accepted"] = [];
  const failures: BroadcastMessageResult["failures"] = [];
  results.forEach((result, index) => {
    const recipient = recipients[index];
    if (result.status === "fulfilled") {
      accepted.push({ recipient, messageId: result.value.id });
    } else {
      failures.push({
        recipient,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
  if (failures.length > 0) {
    console.error(`Broadcast partially failed: ${failures.length} messages could not be delivered.`);
    failures.forEach((failure) => console.error(`- ${failure.recipient}: ${failure.error}`));
  }
  return { accepted, failures };
}
