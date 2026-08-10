import fs from "node:fs";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { IdentifiedInboxMessage } from "./delivery-contracts";
import {
  type DirectMessageBatch,
  type DirectMessageBatchDetails,
  type DirectMessageDeliverySink,
  type DirectMessageObservation,
  type AlertMembershipPort,
} from "./contracts";
import * as inboxDelivery from "./inbox-delivery";
import { inboxPath } from "../utils/paths";

export {
  type DirectMessageBatch,
  type DirectMessageBatchDetails,
  type DirectMessageDeliverySink,
} from "./contracts";

export const DIRECT_MESSAGE_CUSTOM_TYPE = "pi-teams.direct-message";
export const DIRECT_MESSAGE_RESUME_TYPE = "pi-teams.direct-message-resume";
export const DIRECT_MESSAGE_ACK_ENTRY_TYPE = "pi-teams.direct-message-successful-turn-ack";
export const MESSAGE_POLL_MS_ENV = "PI_TEAMS_MESSAGE_POLL_MS";
export const DEFAULT_MESSAGE_POLL_MS = 30_000;

interface ContextMessage {
  role?: unknown;
  customType?: unknown;
  details?: unknown;
}

interface DeliveryDependencies {
  readUnread: () => Promise<IdentifiedInboxMessage[]>;
  markRead: (ids: Iterable<string>) => Promise<number>;
  isCurrentBinding: () => Promise<boolean>;
  watch: (onHint: () => void) => () => void;
}

export interface DirectMessageDeliveryOptions {
  teamName: string;
  recipient: string;
  membershipId: string;
  sessionFile: string;
  pollMs?: number;
  membership: AlertMembershipPort;
  dependencies?: Partial<DeliveryDependencies>;
}

export function messagePollMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MESSAGE_POLL_MS_ENV];
  if (!raw) return DEFAULT_MESSAGE_POLL_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MESSAGE_POLL_MS;
}

export function formatDirectMessageBatch(messages: IdentifiedInboxMessage[]): string {
  return [
    "[PiTeams native coordination delivery]",
    "These accepted coordination records were delivered to this exact Session. Act on their full contents; presentation does not change Task state.",
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
    || details.schemaVersion !== 2
    || typeof details.teamName !== "string"
    || typeof details.recipient !== "string"
    || typeof details.recipientMembershipId !== "string"
    || typeof details.recipientSessionFile !== "string"
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
  membershipId: string,
  sessionFile: string,
): string[] {
  if (customType !== DIRECT_MESSAGE_CUSTOM_TYPE) return [];
  const details = detailsFromValue(detailsValue);
  if (
    !details
    || details.teamName !== teamName
    || details.recipient !== recipient
    || details.recipientMembershipId !== membershipId
    || details.recipientSessionFile !== sessionFile
  ) return [];
  return details.messageIds;
}

/** Extract successful-turn acknowledgements from canonical Pi Session entries. */
export function acknowledgedMessageIdsFromEntries(
  entries: readonly SessionEntry[],
  teamName: string,
  recipient: string,
  membershipId: string,
  sessionFile: string,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== DIRECT_MESSAGE_ACK_ENTRY_TYPE) continue;
    const details = detailsFromValue(entry.data);
    if (
      !details
      || details.teamName !== teamName
      || details.recipient !== recipient
      || details.recipientMembershipId !== membershipId
      || details.recipientSessionFile !== sessionFile
    ) continue;
    for (const id of details.messageIds) ids.add(id);
  }
  return ids;
}

/** Find full Message batches persisted immediately before a crash but not yet acknowledged. */
export function pendingPresentedMessageIdsFromEntries(
  entries: readonly SessionEntry[],
  teamName: string,
  recipient: string,
  membershipId: string,
  sessionFile: string,
): Set<string> {
  const observed = acknowledgedMessageIdsFromEntries(
    entries,
    teamName,
    recipient,
    membershipId,
    sessionFile,
  );
  const pending = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom_message") continue;
    for (const id of observedIdsFromCustom(
      entry.customType,
      entry.details,
      teamName,
      recipient,
      membershipId,
      sessionFile,
    )) {
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
  membershipId: string,
  sessionFile: string,
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "custom") continue;
    for (const id of observedIdsFromCustom(
      message.customType,
      message.details,
      teamName,
      recipient,
      membershipId,
      sessionFile,
    )) ids.add(id);
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
  private readonly membershipId: string;
  private readonly sessionFile: string;
  private readonly pollMs: number;
  private readonly sink: DirectMessageDeliverySink;
  private readonly dependencies: DeliveryDependencies;
  private readonly attempted = new Set<string>();
  private readonly acknowledged = new Set<string>();
  private readonly staged = new Set<string>();
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
    this.membershipId = options.membershipId;
    this.sessionFile = options.sessionFile;
    this.pollMs = options.pollMs ?? DEFAULT_MESSAGE_POLL_MS;
    this.dependencies = {
      readUnread: options.dependencies?.readUnread
        ?? (() => inboxDelivery.readInboxForMembership(
          this.teamName,
          this.recipient,
          this.membershipId,
          true,
          false,
        )),
      markRead: options.dependencies?.markRead
        ?? ((ids) => inboxDelivery.markMessagesReadForMembership(
          this.teamName,
          this.recipient,
          this.membershipId,
          ids,
        )),
      isCurrentBinding: options.dependencies?.isCurrentBinding
        ?? (() => options.membership.isCurrentSessionBinding({
          teamName: this.teamName,
          recipient: this.recipient,
          membershipId: this.membershipId,
          sessionFile: this.sessionFile,
        })),
      watch: options.dependencies?.watch
        ?? ((onHint) => watchInboxFile(this.teamName, this.recipient, onHint)),
    };
  }

  async start(sessionEntries: readonly SessionEntry[]): Promise<void> {
    this.stop();
    this.attempted.clear();
    this.acknowledged.clear();
    this.staged.clear();
    this.stopped = false;
    if (!await this.dependencies.isCurrentBinding()) {
      this.stop();
      return;
    }
    const acknowledged = acknowledgedMessageIdsFromEntries(
      sessionEntries,
      this.teamName,
      this.recipient,
      this.membershipId,
      this.sessionFile,
    );
    for (const id of acknowledged) {
      this.acknowledged.add(id);
      this.attempted.add(id);
    }
    if (acknowledged.size > 0) await this.dependencies.markRead(acknowledged);
    const presented = pendingPresentedMessageIdsFromEntries(
      sessionEntries,
      this.teamName,
      this.recipient,
      this.membershipId,
      this.sessionFile,
    );
    for (const id of presented) this.attempted.add(id);
    this.stopWatch = this.dependencies.watch(() => this.scheduleHintScan());
    this.interval = setInterval(() => void this.scan().catch(() => undefined), this.pollMs);
    if (presented.size > 0) {
      const messageIds = [...presented];
      this.sink.sendMessage({
        customType: DIRECT_MESSAGE_RESUME_TYPE,
        content: `Resume delivery of the already-recorded PiTeams coordination records with IDs: ${messageIds.join(", ")}. Their full contents are in the preceding canonical custom entries. Presentation does not change Task state.`,
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
    this.staged.clear();
  }

  async observeContext(messages: readonly ContextMessage[]): Promise<number> {
    if (this.stopped) return 0;
    const contextIds = observedMessageIdsFromContext(
      messages,
      this.teamName,
      this.recipient,
      this.membershipId,
      this.sessionFile,
    );
    let staged = 0;
    for (const id of contextIds) {
      if (this.acknowledged.has(id) || this.staged.has(id)) continue;
      this.staged.add(id);
      this.attempted.add(id);
      staged += 1;
    }
    return staged;
  }

  async commitPresentedAfterSuccessfulTurn(stopReason: unknown): Promise<number> {
    if (this.stopped || stopReason === "error" || stopReason === "aborted") return 0;
    if (!await this.dependencies.isCurrentBinding()) {
      this.stop();
      return 0;
    }
    const ids = [...this.staged].filter((id) => !this.acknowledged.has(id));
    if (ids.length === 0) return 0;
    this.sink.appendEntry(DIRECT_MESSAGE_ACK_ENTRY_TYPE, this.observation(ids));
    for (const id of ids) this.acknowledged.add(id);
    const marked = await this.dependencies.markRead(ids);
    for (const id of ids) this.staged.delete(id);
    return marked;
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
    if (!await this.dependencies.isCurrentBinding()) {
      this.stop();
      return;
    }
    const unread = await this.dependencies.readUnread();
    // Defend the identity boundary even when a test or alternate storage
    // dependency accidentally returns historical or foreign-generation rows.
    const pending = unread.filter((message) =>
      message.recipientMembershipId === this.membershipId
      && !this.attempted.has(message.id)
    );
    if (pending.length === 0) return;
    // Replacement can occur while the inbox read is in flight. Recheck at
    // the effect boundary so the old generation cannot steer afterward.
    if (!await this.dependencies.isCurrentBinding()) {
      this.stop();
      return;
    }

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
      schemaVersion: 2,
      teamName: this.teamName,
      recipient: this.recipient,
      recipientMembershipId: this.membershipId,
      recipientSessionFile: this.sessionFile,
      messageIds,
    };
  }
}
