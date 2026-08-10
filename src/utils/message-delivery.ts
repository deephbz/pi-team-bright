import { DurableAlertMembership } from "../adapters/durable-alert-membership";
import {
  DirectMessageDelivery as CanonicalDirectMessageDelivery,
  type DirectMessageDeliveryOptions,
} from "../alert-authority/direct-delivery";
import type { DirectMessageDeliverySink } from "../alert-authority/contracts";

export * from "../alert-authority/direct-delivery";

/** Compatibility facade for historical utility callers. */
export class DirectMessageDelivery extends CanonicalDirectMessageDelivery {
  constructor(
    sink: DirectMessageDeliverySink,
    options: Omit<DirectMessageDeliveryOptions, "membership">,
  ) {
    super(sink, { ...options, membership: new DurableAlertMembership() });
  }
}
