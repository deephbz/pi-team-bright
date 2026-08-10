import type { TaskVersionRef } from "../task-authority/task-version-ref";

export const ALERT_KINDS = ["clarification", "attention", "announcement"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface AlertTaskReference {
  taskId: string;
  version?: TaskVersionRef;
}

export interface ExpectedSenderBinding {
  membershipId: string;
  sessionFile: string;
}

/** Receipt for one accepted Alert inbox delivery. */
export interface AcceptedAlertDelivery {
  recipient: string;
  messageId: string;
}

export interface SendAlertInput {
  teamName: string;
  from: string;
  to: string | "*";
  kind: AlertKind;
  text: string;
  taskId?: string;
  taskVersion?: string;
  expectedSender?: ExpectedSenderBinding;
}

export interface SendAlertResult {
  alertId: string;
  cursor: string;
  accepted: AcceptedAlertDelivery[];
  failures: Array<{ recipient: string; error: string }>;
}

/** Alert's current-recipient, leased-delivery, and exact Session-binding boundary. */
export interface AlertMembershipPort {
  currentRecipients(teamName: string, excluding: string): Promise<AlertRecipientSnapshot>;
  withCurrentDelivery<T>(
    input: AlertDeliveryLeaseInput,
    append: (delivery: AlertCurrentDelivery) => Promise<T>,
  ): Promise<AlertDeliveryLeaseResult<T>>;
  isCurrentSessionBinding(input: AlertSessionBinding): Promise<boolean>;
}

export interface AlertRecipient {
  name: string;
}

export type AlertRecipientSnapshot =
  | { kind: "team_absent" }
  | { kind: "current"; recipients: AlertRecipient[] };

export interface AlertDeliveryLeaseInput {
  teamName: string;
  from: string;
  to: string;
  expectedSender?: ExpectedSenderBinding;
}

export interface AlertCurrentDelivery {
  recipientMembershipId: string;
  senderMembershipId?: string;
}

export type AlertDeliveryLeaseResult<T> =
  | { kind: "team_absent" }
  | { kind: "recipient_absent" }
  | { kind: "recipient_unresolved" }
  | { kind: "sender_stale" }
  | { kind: "delivered"; value: T };

export interface AlertSessionBinding {
  teamName: string;
  recipient: string;
  membershipId: string;
  sessionFile: string;
}

/** Alert's publication boundary after accepted durable inbox delivery. */
export interface AlertPublicationPort {
  appendAcceptedAlert(input: AlertPublicationInput): Promise<{ cursor: string }>;
}

export interface AlertPublicationInput {
  teamName: string;
  alertId: string;
  from: string;
  to: string | "*";
  taskRef?: AlertTaskReference;
  kind: AlertKind;
  text: string;
}

/** Consumer-facing sender that binds Alert authority to durable ports. */
export interface AlertSender {
  sendAlert(input: SendAlertInput): Promise<SendAlertResult>;
}

export interface BroadcastMessageResult {
  accepted: AcceptedAlertDelivery[];
  failures: Array<{ recipient: string; error: string }>;
}

export interface DirectMessageBatchDetails {
  authority: "pi-teams-message";
  schemaVersion: 2;
  teamName: string;
  recipient: string;
  recipientMembershipId: string;
  recipientSessionFile: string;
  messageIds: string[];
}

export interface DirectMessageBatch {
  customType: "pi-teams.direct-message";
  content: string;
  display: true;
  details: DirectMessageBatchDetails;
}

export interface DirectMessageObservation extends DirectMessageBatchDetails {}

/** Consumer-owned Pi Session presentation port. */
export interface DirectMessageDeliverySink {
  sendMessage(
    message: DirectMessageBatch | {
      customType: "pi-teams.direct-message-resume";
      content: string;
      display: false;
      details: DirectMessageObservation;
    },
    options: { triggerTurn: true; deliverAs: "steer" },
  ): void;
  appendEntry(
    customType: "pi-teams.direct-message-successful-turn-ack",
    data: DirectMessageObservation,
  ): void;
}
