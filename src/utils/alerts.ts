import { DurableAlertMembership } from "../adapters/durable-alert-membership";
import { DurableAlertPublication } from "../adapters/durable-alert-publication";
import { ALERT_KINDS, createAlertSender } from "../alert-authority/alerts";
import type {
  AcceptedAlertDelivery,
  AlertKind,
  AlertTaskReference,
  ExpectedSenderBinding,
  SendAlertInput,
  SendAlertResult,
} from "../alert-authority/contracts";

export { ALERT_KINDS };
export type {
  AcceptedAlertDelivery,
  AlertKind,
  AlertTaskReference,
  ExpectedSenderBinding,
  SendAlertInput,
  SendAlertResult,
};

/** Compatibility facade for historical utility callers. */
export function sendAlert(input: SendAlertInput) {
  return createAlertSender(
    new DurableAlertMembership(),
    new DurableAlertPublication(),
  ).sendAlert(input);
}
