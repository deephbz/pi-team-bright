import { hostEnv } from "../env/host-env";
import * as inboxDelivery from "./inbox-delivery";
import type { TaskVersionRef } from "../task-authority/task-version-ref";
import type { RecentReceivedAlerts } from "./contracts";
import {
  ALERT_KINDS,
  type AcceptedAlertDelivery,
  type AlertKind,
  type AlertMembershipPort,
  type AlertPublicationPort,
  type AlertSender,
  type AlertTaskReference,
  type ExpectedSenderBinding,
  type SendAlertInput,
  type SendAlertResult,
} from "./contracts";

export {
  ALERT_KINDS,
  type AcceptedAlertDelivery,
  type AlertKind,
  type AlertMembershipPort,
  type AlertPublicationPort,
  type AlertSender,
  type AlertTaskReference,
  type ExpectedSenderBinding,
  type SendAlertInput,
  type SendAlertResult,
} from "./contracts";

function validateAlert(input: SendAlertInput): void {
  if (!ALERT_KINDS.includes(input.kind)) {
    throw new Error(`Invalid Alert kind '${input.kind}'. Expected clarification, attention, or announcement.`);
  }
  if (!input.text.trim()) throw new Error("Alert text must not be empty.");
  if (!input.to.trim()) throw new Error("Alert recipient must not be empty.");
  if (input.taskVersion && !input.taskId) {
    throw new Error("taskVersion requires taskId so the Alert has an unambiguous Task reference.");
  }
  if (input.to === "*" && input.kind !== "announcement") {
    throw new Error("Only announcement Alerts may target the whole Team.");
  }
  if (input.to === "*" && input.from !== "team-lead") {
    throw new Error("Only team-lead may send a Team announcement.");
  }
  if (input.kind === "announcement" && input.to !== "*") {
    throw new Error("Announcement Alerts must target the whole Team with to: '*'.");
  }
}

function assertTaskVersionRef(value: string): TaskVersionRef {
  if (/^v_[0-9a-f]{16}$/.test(value)) return value as TaskVersionRef;
  const error = new Error("Alert Task references require the canonical opaque TaskVersionRef.");
  error.name = "upgrade_required";
  throw error;
}

function taskReference(input: SendAlertInput): AlertTaskReference | undefined {
  if (!input.taskId) return undefined;
  return {
    taskId: input.taskId,
    ...(input.taskVersion
      ? { version: assertTaskVersionRef(input.taskVersion) }
      : {}),
  };
}

const ALERT_TRAILER = "This Alert is exceptional coordination only. It does not assign, advance, block, or complete a Task.";

export function deliveryText(
  alertId: string,
  kind: AlertKind,
  text: string,
  taskRef: AlertTaskReference | undefined,
): string {
  return [
    `[PiTeams ${kind} Alert ${alertId}]`,
    ...(taskRef
      ? [`Task: ${taskRef.taskId}${taskRef.version ? ` @ ${taskRef.version}` : ""}`]
      : []),
    text,
    ALERT_TRAILER,
  ].join("\n");
}

/** Decode only the envelope emitted above; ordinary inbox messages stay out. */
export function parseAlertDeliveryText(value: string): { alertId: string; kind: AlertKind; text: string; taskRef?: AlertTaskReference } | undefined {
  const lines = value.split("\n");
  const header = /^\[PiTeams (clarification|attention|announcement) Alert (alert_[^\s\]]+)\]$/.exec(lines[0] ?? "");
  if (!header || lines.at(-1) !== ALERT_TRAILER) return undefined;
  const task = /^Task: (.+?)(?: @ (v_[0-9a-f]{16}))?$/.exec(lines[1] ?? "");
  const text = lines.slice(task ? 2 : 1, -1).join("\n");
  if (!text.trim()) return undefined;
  return { alertId: header[2], kind: header[1] as AlertKind, text,
    ...(task ? { taskRef: { taskId: task[1], ...(task[2] ? { version: assertTaskVersionRef(task[2]) } : {}) } } : {}) };
}

/** Inbox append order proves receipt order even when sender clocks disagree. */
export async function readRecentReceivedAlerts(teamName: string, memberName: string, membershipId: string, limit: number): Promise<RecentReceivedAlerts> {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("Received Alert limit must be a nonnegative integer.");
  const messages = await inboxDelivery.readStoredInboxForMembership(teamName, memberName, membershipId);
  const eligible = messages.flatMap(message => {
    const parsed = typeof message.text === "string" ? parseAlertDeliveryText(message.text) : undefined;
    return parsed && typeof message.from === "string" && typeof message.timestamp === "string"
      ? [{ message, parsed }] : [];
  }).reverse();
  return {
    alerts: eligible.slice(0, limit).map(({ message, parsed }) => {
      const points = Array.from(parsed.text);
      return { alertId: parsed.alertId, from: message.from, kind: parsed.kind,
        ...(parsed.taskRef ? { taskId: parsed.taskRef.taskId, ...(parsed.taskRef.version ? { taskVersion: parsed.taskRef.version } : {}) } : {}),
        receivedAt: message.timestamp, text: points.slice(0, 2000).join(""),
        ...(points.length > 2000 ? { truncated: true as const, textLength: points.length } : {}) };
    }),
    omitted: Math.max(0, eligible.length - limit),
  };
}

function deliverySummary(kind: AlertKind, taskRef: AlertTaskReference | undefined): string {
  return taskRef ? `${kind} for Task ${taskRef.taskId}` : `${kind} Alert`;
}

/**
 * Accept one typed Alert, reuse the existing exact-Membership native delivery
 * transport, then publish the compact Alert to the Team event journal. The
 * legacy inbox is an internal delivery queue; callers receive no inbox API.
 */
export function createAlertSender(
  membership: AlertMembershipPort,
  publication: AlertPublicationPort,
): AlertSender {
  return { sendAlert: (input) => sendAlert(input, membership, publication) };
}

/** Accept one Alert through explicitly injected Team and Coordination ports. */
export async function sendAlert(
  input: SendAlertInput,
  membership: AlertMembershipPort,
  publication: AlertPublicationPort,
): Promise<SendAlertResult> {
  validateAlert(input);
  const alertId = `alert_${hostEnv().random.uuid()}`;
  const taskRef = taskReference(input);
  const text = deliveryText(alertId, input.kind, input.text.trim(), taskRef);
  const summary = deliverySummary(input.kind, taskRef);

  let accepted: AcceptedAlertDelivery[];
  let failures: Array<{ recipient: string; error: string }>;
  if (input.to === "*") {
    const result = await inboxDelivery.broadcastMessage(
      input.teamName,
      input.from,
      text,
      summary,
      undefined,
      input.expectedSender,
      membership,
    );
    accepted = result.accepted;
    failures = result.failures;
  } else {
    const message = await inboxDelivery.sendPlainMessage(
      input.teamName,
      input.from,
      input.to,
      text,
      summary,
      undefined,
      input.expectedSender,
      membership,
    );
    accepted = [{ recipient: input.to, messageId: message.id }];
    failures = [];
  }

  if (accepted.length === 0) {
    throw new Error(`Alert ${alertId} was not accepted by any current Team member.`);
  }

  const event = await publication.appendAcceptedAlert({
    teamName: input.teamName,
    alertId,
    from: input.from,
    to: input.to,
    ...(taskRef ? { taskRef } : {}),
    kind: input.kind,
    text: input.text.trim(),
  });

  return {
    alertId,
    cursor: event.cursor,
    accepted,
    failures,
  };
}
