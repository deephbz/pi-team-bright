import { readProcessGeneration } from "../env/async-process-generation";
import { currentDeliveryDegradations, verifyRuntimeGeneration, readRuntimeStatus } from "../utils/runtime";
import { readConfig, teamExists, withCurrentConfig } from "../utils/teams";
import type {
  AlertCurrentDelivery,
  AlertDeliveryLeaseInput,
  AlertDeliveryLeaseResult,
  AlertMembershipPort,
  AlertRecipientSnapshot,
  AlertSessionBinding,
} from "../alert-authority/contracts";

/** Durable Team authority adapter for Alert membership operations. */
export class DurableAlertMembership implements AlertMembershipPort {
  async currentRecipients(teamName: string, excluding: string): Promise<AlertRecipientSnapshot> {
    if (!teamExists(teamName)) return { kind: "team_absent" };
    const config = await readConfig(teamName);
    return {
      kind: "current",
      recipients: config.members
        .filter((member) => member.isActive !== false && member.name !== excluding)
        .map((member) => ({ name: member.name })),
    };
  }

  async withCurrentDelivery<T>(
    input: AlertDeliveryLeaseInput,
    append: (delivery: AlertCurrentDelivery) => Promise<T>,
  ): Promise<AlertDeliveryLeaseResult<T>> {
    if (!teamExists(input.teamName)) return { kind: "team_absent" };
    return await withCurrentConfig(input.teamName, async (config) => {
      const recipient = [...config.members].reverse().find(
        (member) => member.name === input.to && member.isActive !== false,
      );
      if (!recipient) return { kind: "recipient_absent" };
      if (!recipient.membershipId) return { kind: "recipient_unresolved" };
      const sender = [...config.members].reverse().find(
        (member) => member.name === input.from && member.isActive !== false,
      );
      if (input.expectedSender && (
        !sender
        || sender.membershipId !== input.expectedSender.membershipId
        || sender.sessionFile !== input.expectedSender.sessionFile
      )) return { kind: "sender_stale" };
      // Delivery health is diagnostic. Missing evidence cannot refuse a durable send.
      const deliveryDegraded = await readRuntimeStatus(input.teamName, recipient.name)
        .then(async status => {
          const verified = status?.pid && status.osBirthToken && status.bootId
            ? verifyRuntimeGeneration(status, await readProcessGeneration(status.pid)) : "unknown";
          return currentDeliveryDegradations(recipient, status, verified);
        }).catch(() => []);
      return {
        kind: "delivered",
        value: await append({
          recipientMembershipId: recipient.membershipId,
          ...(deliveryDegraded.length ? { deliveryDegraded } : {}),
          ...(sender?.membershipId ? { senderMembershipId: sender.membershipId } : {}),
        }),
      };
    });
  }

  async isCurrentSessionBinding(input: AlertSessionBinding): Promise<boolean> {
    if (!teamExists(input.teamName)) return false;
    const config = await readConfig(input.teamName);
    return [...config.members].reverse().some((member) =>
      member.name === input.recipient
      && member.isActive !== false
      && member.membershipId === input.membershipId
      && member.sessionFile === input.sessionFile,
    );
  }
}
