import { DurableAlertMembership } from "../adapters/durable-alert-membership";
import {
  DirectMessageDelivery as CanonicalDirectMessageDelivery,
  type DirectMessageDeliveryOptions,
} from "../alert-authority/direct-delivery";
import type { DirectMessageDeliverySink } from "../alert-authority/contracts";

export {
  DEFAULT_MESSAGE_POLL_MS,
  DIRECT_MESSAGE_ACK_ENTRY_TYPE,
  DIRECT_MESSAGE_CUSTOM_TYPE,
  DIRECT_MESSAGE_RESUME_TYPE,
  MESSAGE_POLL_MS_ENV,
  acknowledgedMessageIdsFromEntries,
  formatDirectMessageBatch,
  messagePollMs,
  observedMessageIdsFromContext,
  pendingPresentedMessageIdsFromEntries,
} from "../alert-authority/direct-delivery";
export type {
  DirectMessageBatch,
  DirectMessageBatchDetails,
  DirectMessageDeliveryOptions,
  DirectMessageDeliverySink,
} from "../alert-authority/direct-delivery";

/** Compatibility facade for historical utility callers. */
export class DirectMessageDelivery extends CanonicalDirectMessageDelivery {
  constructor(
    sink: DirectMessageDeliverySink,
    options: Omit<DirectMessageDeliveryOptions, "membership">,
  ) {
    super(sink, { ...options, membership: new DurableAlertMembership() });
  }
}
