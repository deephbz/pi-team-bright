import fs from "node:fs";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { IdentifiedInboxMessage } from "./models";
import * as messaging from "./messaging";
import { inboxPath } from "./paths";

export const DIRECT_MESSAGE_CUSTOM_TYPE = "pi-teams.direct-message";
export const DIRECT_MESSAGE_RESUME_TYPE = "pi-teams.direct-message-resume";
export const DIRECT_MESSAGE_OBSERVED_ENTRY_TYPE = "pi-teams.direct-message-context-observed";
export const MESSAGE_DELIVERY_ENV = "PI_TEAMS_MESSAGE_DELIVERY";
export const MESSAGE_POLL_MS_ENV = "PI_TEAMS_MESSAGE_POLL_MS";
export const DEFAULT_MESSAGE_POLL_MS = 30_000;

export interface DirectMessageBatchDetails {
  authority: "pi-teams-message";
  schemaVersion: 1;
  teamName: string;
  recipient: string;
  messageIds: string[];
}

export interface DirectMessageBatch {
  customType: typeof DIRECT_MESSAGE_CUSTOM_TYPE;
  content: string;
  display: true;
  details: DirectMessageBatchDetails;
}

interface DirectMessageObservation {
  authority: "pi-teams-message";
  schemaVersion: 1;
  teamName: string;
  recipient: string;
  messageIds: string[];
}

export interface DirectMessageDeliverySink {
  sendMessage(
    message: DirectMessageBatch | {
      customType: typeof DIRECT_MESSAGE_RESUME_TYPE;
      content: string;
      display: false;
      details: DirectMessageObservation;
    },
    options: { triggerTurn: true; deliverAs: "steer" },
  ): void;
  appendEntry(customType: typeof DIRECT_MESSAGE_OBSERVED_ENTRY_TYPE, data: DirectMessageObservation): void;
}

interface ContextMessage {
  role?: unknown;
  customType?: unknown;
  details?: unknown;
}

interface DeliveryDependencies {
  readUnread: () => Promise<IdentifiedInboxMessage[]>;
  markRead: (ids: Iterable<string>) => Promise<number>;
  watch: (onHint: () => void) => () => void;
}

interface DirectMessageDeliveryOptions {
  teamName: string;
  recipient: string;
  pollMs?: number;
  dependencies?: Partial<DeliveryDependencies>;
}

export function directMessageDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MESSAGE_DELIVERY_ENV]?.trim().toLowerCase() === "steer";
}

export function messagePollMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MESSAGE_POLL_MS_ENV];
  if (!raw) return DEFAULT_MESSAGE_POLL_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MESSAGE_POLL_MS;
}

export function formatDirectMessageBatch(messages: IdentifiedInboxMessage[]): string {
  return [
    "[PiTeams direct Messages]",
    "These Messages were already accepted by the Communication inbox. Act on their full contents; do not call read_inbox just to retrieve them.",
    JSON.stringify({
      messages: messages.map((message) => ({
        id: message.id,
        from: message.from,
        sentAt: message.timestamp,
        summary: message.summary,
        content: message.text,
      })),
    }, null, 2),
  ].join("\n");
}

function detailsFromValue(value: unknown): DirectMessageBatchDetails | null {
  if (!value || typeof value !== "object") return null;
  const details = value as Partial<DirectMessageBatchDetails>;
  if (
    details.authority !== "pi-teams-message"
    || details.schemaVersion !== 1
    || typeof details.teamName !== "string"
    || typeof details.recipient !== "string"
    || !Array.isArray(details.messageIds)
    || !details.messageIds.every((id) => typeof id === "string")
  ) {
    return null;
  }
  return details as DirectMessageBatchDetails;
}

function observedIdsFromCustom(
  customType: unknown,
  detailsValue: unknown,
  teamName: string,
  recipient: string,
): string[] {
  if (customType !== DIRECT_MESSAGE_CUSTOM_TYPE) return [];
  const details = detailsFromValue(detailsValue);
  if (!details || details.teamName !== teamName || details.recipient !== recipient) return [];
  return details.messageIds;
}

/** Extract context-observation acknowledgements from canonical Pi Session entries. */
export function observedMessageIdsFromEntries(
  entries: readonly SessionEntry[],
  teamName: string,
  recipient: string,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== DIRECT_MESSAGE_OBSERVED_ENTRY_TYPE) continue;
    const details = detailsFromValue(entry.data);
    if (!details || details.teamName !== teamName || details.recipient !== recipient) continue;
    for (const id of details.messageIds) ids.add(id);
  }
  return ids;
}

/** Find full Message batches persisted immediately before a crash but not yet context-observed. */
export function pendingPresentedMessageIdsFromEntries(
  entries: readonly SessionEntry[],
  teamName: string,
  recipient: string,
): Set<string> {
  const observed = observedMessageIdsFromEntries(entries, teamName, recipient);
  const pending = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom_message") continue;
    for (const id of observedIdsFromCustom(entry.customType, entry.details, teamName, recipient)) {
      if (!observed.has(id)) pending.add(id);
    }
  }
  return pending;
}

/** Extract Message IDs present in the exact provider context about to be sent. */
export function observedMessageIdsFromContext(
  messages: readonly ContextMessage[],
  teamName: string,
  recipient: string,
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "custom") continue;
    for (const id of observedIdsFromCustom(message.customType, message.details, teamName, recipient)) ids.add(id);
  }
  return ids;
}

function watchInboxFile(teamName: string, recipient: string, onHint: () => void): () => void {
  const target = inboxPath(teamName, recipient);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const targetName = path.basename(target);
  const watcher = fs.watch(directory, (_eventType, filename) => {
    if (!filename || filename.toString() === targetName) onHint();
  });
  watcher.on("error", () => {
    // The fallback rescan remains authoritative when a filesystem watch fails.
  });
  return () => watcher.close();
}

/**
 * Recipient-side projection from durable inbox Messages into Pi custom steer.
 * The inbox owns acceptance/read state; this class owns only presentation attempts.
 */
export class DirectMessageDelivery {
  private readonly teamName: string;
  private readonly recipient: string;
  private readonly pollMs: number;
  private readonly sink: DirectMessageDeliverySink;
  private readonly dependencies: DeliveryDependencies;
  private readonly attempted = new Set<string>();
  private readonly observed = new Set<string>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopWatch: (() => void) | null = null;
  private stopped = true;
  private scanPromise: Promise<void> | null = null;
  private rescanRequested = false;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(sink: DirectMessageDeliverySink, options: DirectMessageDeliveryOptions) {
    this.sink = sink;
    this.teamName = options.teamName;
    this.recipient = options.recipient;
    this.pollMs = options.pollMs ?? DEFAULT_MESSAGE_POLL_MS;
    this.dependencies = {
      readUnread: options.dependencies?.readUnread
        ?? (() => messaging.readInbox(this.teamName, this.recipient, true, false)),
      markRead: options.dependencies?.markRead
        ?? ((ids) => messaging.markMessagesRead(this.teamName, this.recipient, ids)),
      watch: options.dependencies?.watch
        ?? ((onHint) => watchInboxFile(this.teamName, this.recipient, onHint)),
    };
  }

  async start(sessionEntries: readonly SessionEntry[]): Promise<void> {
    this.stop();
    this.attempted.clear();
    this.observed.clear();
    this.stopped = false;
    const observed = observedMessageIdsFromEntries(sessionEntries, this.teamName, this.recipient);
    for (const id of observed) {
      this.observed.add(id);
      this.attempted.add(id);
    }
    if (observed.size > 0) await this.dependencies.markRead(observed);
    const presented = pendingPresentedMessageIdsFromEntries(sessionEntries, this.teamName, this.recipient);
    for (const id of presented) this.attempted.add(id);
    this.stopWatch = this.dependencies.watch(() => this.scheduleHintScan());
    this.interval = setInterval(() => void this.scan().catch(() => undefined), this.pollMs);
    if (presented.size > 0) {
      const messageIds = [...presented];
      this.sink.sendMessage({
        customType: DIRECT_MESSAGE_RESUME_TYPE,
        content: `Resume delivery of the already-recorded PiTeams direct Messages with IDs: ${messageIds.join(", ")}. Their full contents are in the preceding canonical custom Message entries. Treat each ID as one logical Message.`,
        display: false,
        details: this.observation(messageIds),
      }, { triggerTurn: true, deliverAs: "steer" });
    }
    await this.scan();
  }

  stop(): void {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.stopWatch?.();
    this.interval = null;
    this.hintTimer = null;
    this.stopWatch = null;
    this.rescanRequested = false;
  }

  async observeContext(messages: readonly ContextMessage[]): Promise<number> {
    if (this.stopped) return 0;
    const contextIds = observedMessageIdsFromContext(messages, this.teamName, this.recipient);
    const ids = new Set([...contextIds].filter((id) => !this.observed.has(id)));
    if (ids.size === 0) return 0;
    this.sink.appendEntry(DIRECT_MESSAGE_OBSERVED_ENTRY_TYPE, this.observation([...ids]));
    for (const id of ids) {
      this.observed.add(id);
      this.attempted.add(id);
    }
    try {
      return await this.dependencies.markRead(ids);
    } catch (error) {
      for (const id of ids) this.observed.delete(id);
      throw error;
    }
  }

  async scan(): Promise<void> {
    if (this.stopped) return;
    if (this.scanPromise) {
      this.rescanRequested = true;
      return await this.scanPromise;
    }
    this.scanPromise = this.scanLoop();
    try {
      await this.scanPromise;
    } finally {
      this.scanPromise = null;
    }
  }

  private scheduleHintScan(): void {
    if (this.stopped || this.hintTimer) return;
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      void this.scan().catch(() => undefined);
    }, 20);
  }

  private async scanLoop(): Promise<void> {
    do {
      this.rescanRequested = false;
      await this.scanOnce();
    } while (this.rescanRequested && !this.stopped);
  }

  private async scanOnce(): Promise<void> {
    if (this.stopped) return;
    const unread = await this.dependencies.readUnread();
    const pending = unread.filter((message) => !this.attempted.has(message.id));
    if (pending.length === 0) return;

    const messageIds = pending.map((message) => message.id);
    for (const id of messageIds) this.attempted.add(id);
    try {
      this.sink.sendMessage({
        customType: DIRECT_MESSAGE_CUSTOM_TYPE,
        content: formatDirectMessageBatch(pending),
        display: true,
        details: this.observation(messageIds),
      }, { triggerTurn: true, deliverAs: "steer" });
    } catch (error) {
      for (const id of messageIds) this.attempted.delete(id);
      throw error;
    }
  }

  private observation(messageIds: string[]): DirectMessageObservation {
    return {
      authority: "pi-teams-message",
      schemaVersion: 1,
      teamName: this.teamName,
      recipient: this.recipient,
      messageIds,
    };
  }
}
