import { DurableAlertMembership } from "../adapters/durable-alert-membership";
import * as canonical from "../alert-authority/inbox-delivery";
import type { ExpectedSenderBinding } from "../alert-authority/contracts";

export {
  MessageTeamDoesNotExistError, RecipientMembershipUnresolvedError, RecipientNotCurrentMemberError,
  appendMessage, markMessagesRead, markMessagesReadForMembership, nowIso, readInbox, readInboxForMembership,
} from "../alert-authority/inbox-delivery";
export type { BroadcastMessageResult, ExpectedSenderBinding } from "../alert-authority/contracts";

/** Compatibility facade for historical utility callers. */
export function sendPlainMessage(
  teamName: string,
  fromName: string,
  toName: string,
  text: string,
  summary: string,
  color?: string,
  expectedSender?: ExpectedSenderBinding,
) {
  return canonical.sendPlainMessage(
    teamName, fromName, toName, text, summary, color, expectedSender, new DurableAlertMembership(),
  );
}

/** Compatibility facade for historical utility callers. */
export function broadcastMessage(
  teamName: string,
  fromName: string,
  text: string,
  summary: string,
  color?: string,
  expectedSender?: ExpectedSenderBinding,
) {
  return canonical.broadcastMessage(
    teamName, fromName, text, summary, color, expectedSender, new DurableAlertMembership(),
  );
}
