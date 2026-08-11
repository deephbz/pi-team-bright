import type { TaskDeliveryMembershipPort } from "../utils/task-delivery";
import { readConfig, withCurrentSessionBinding } from "../utils/teams";

/** Durable Team authority adapter for Task-change recipient delivery. */
export class DurableTaskChangeDeliveryMembership implements TaskDeliveryMembershipPort {
  async currentRecipient(input: {
    teamName: string;
    recipient: string;
    sessionFile: string;
  }): Promise<{ membershipId: string } | null> {
    const config = await readConfig(input.teamName);
    const member = [...config.members].reverse().find((candidate) =>
      candidate.name === input.recipient
      && candidate.isActive !== false
      && candidate.sessionFile === input.sessionFile,
    );
    return member?.membershipId ? { membershipId: member.membershipId } : null;
  }

  async withCurrentRecipient<T>(
    input: {
      teamName: string;
      recipient: string;
      sessionFile: string;
      membershipId: string;
    },
    action: () => Promise<T>,
  ): Promise<T> {
    return await withCurrentSessionBinding(
      input.teamName,
      input.recipient,
      input.sessionFile,
      input.membershipId,
      action,
    );
  }
}
