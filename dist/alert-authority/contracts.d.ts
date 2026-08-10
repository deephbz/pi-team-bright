import type { TaskVersionRef } from "../task-authority/task-version-ref";
export declare const ALERT_KINDS: readonly ["clarification", "attention", "announcement"];
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
    failures: Array<{
        recipient: string;
        error: string;
    }>;
}
export interface BroadcastMessageResult {
    accepted: AcceptedAlertDelivery[];
    failures: Array<{
        recipient: string;
        error: string;
    }>;
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
export interface DirectMessageObservation extends DirectMessageBatchDetails {
}
/** Consumer-owned Pi Session presentation port. */
export interface DirectMessageDeliverySink {
    sendMessage(message: DirectMessageBatch | {
        customType: "pi-teams.direct-message-resume";
        content: string;
        display: false;
        details: DirectMessageObservation;
    }, options: {
        triggerTurn: true;
        deliverAs: "steer";
    }): void;
    appendEntry(customType: "pi-teams.direct-message-successful-turn-ack", data: DirectMessageObservation): void;
}
