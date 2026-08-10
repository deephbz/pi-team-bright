import { randomUUID } from "node:crypto";
import * as messaging from "./messaging";
import { appendTeamEvent } from "./team-events";
import { type TaskVersionRef } from "../task-authority/task-version-ref";

export const ALERT_KINDS = ["clarification", "attention", "announcement"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface AlertTaskReference {
  taskId: string;
  version?: TaskVersionRef;
}

export interface SendAlertInput {
  teamName: string;
  from: string;
  to: string | "*";
  kind: AlertKind;
  text: string;
  taskId?: string;
  taskVersion?: string;
  expectedSender?: messaging.ExpectedSenderBinding;
}

export interface AcceptedAlertDelivery {
  recipient: string;
  messageId: string;
}

export interface SendAlertResult {
  alertId: string;
  cursor: string;
  accepted: AcceptedAlertDelivery[];
  failures: Array<{ recipient: string; error: string }>;
}

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

function deliveryText(
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
    "This Alert is exceptional coordination only. It does not assign, advance, block, or complete a Task.",
  ].join("\n");
}

function deliverySummary(kind: AlertKind, taskRef: AlertTaskReference | undefined): string {
  return taskRef ? `${kind} for Task ${taskRef.taskId}` : `${kind} Alert`;
}

/**
 * Accept one typed Alert, reuse the existing exact-Membership native delivery
 * transport, then publish the compact Alert to the Team event journal. The
 * legacy inbox is an internal delivery queue; callers receive no inbox API.
 */
export async function sendAlert(input: SendAlertInput): Promise<SendAlertResult> {
  validateAlert(input);
  const alertId = `alert_${randomUUID()}`;
  const taskRef = taskReference(input);
  const text = deliveryText(alertId, input.kind, input.text.trim(), taskRef);
  const summary = deliverySummary(input.kind, taskRef);

  let accepted: AcceptedAlertDelivery[];
  let failures: Array<{ recipient: string; error: string }>;
  if (input.to === "*") {
    const result = await messaging.broadcastMessage(
      input.teamName,
      input.from,
      text,
      summary,
      undefined,
      input.expectedSender,
    );
    accepted = result.accepted;
    failures = result.failures;
  } else {
    const message = await messaging.sendPlainMessage(
      input.teamName,
      input.from,
      input.to,
      text,
      summary,
      undefined,
      input.expectedSender,
    );
    accepted = [{ recipient: input.to, messageId: message.id }];
    failures = [];
  }

  if (accepted.length === 0) {
    throw new Error(`Alert ${alertId} was not accepted by any current Team member.`);
  }

  const event = await appendTeamEvent(input.teamName, {
    type: "alert",
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
