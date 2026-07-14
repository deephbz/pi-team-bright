import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { IdentifiedInboxMessage, InboxMessage } from "./models";
import { withLock } from "./lock";
import { inboxPath } from "./paths";
import { readConfig } from "./teams";

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
    fs.writeFileSync(p, JSON.stringify(msgs, null, 2));
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
      fs.writeFileSync(p, JSON.stringify(allMsgs, null, 2));
    }

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
      fs.writeFileSync(p, JSON.stringify(identified.messages, null, 2));
    }
    return marked;
  });
}

export async function sendPlainMessage(
  teamName: string,
  fromName: string,
  toName: string,
  text: string,
  summary: string,
  color?: string
): Promise<IdentifiedInboxMessage> {
  const msg: InboxMessage = {
    from: fromName,
    text,
    timestamp: nowIso(),
    read: false,
    summary,
    color,
  };
  return await appendMessage(teamName, toName, msg);
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
  color?: string
) {
  const config = await readConfig(teamName);

  // Create an array of delivery promises for all members except the sender
  const deliveryPromises = config.members
    .filter((member) => member.name !== fromName)
    .map((member) => sendPlainMessage(teamName, fromName, member.name, text, summary, color));

  // Execute deliveries in parallel and wait for all to settle
  const results = await Promise.allSettled(deliveryPromises);

  // Log failures for diagnostics
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length > 0) {
    console.error(`Broadcast partially failed: ${failures.length} messages could not be delivered.`);
    // Optionally log individual errors
    failures.forEach((f) => console.error(`- Delivery error:`, f.reason));
  }
}
