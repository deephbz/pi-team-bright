import type { TaskAuthorityBinding, TaskAuthorityTeamPort } from "../task-authority/contracts";
import { assertCurrentSessionBinding, readConfig, withCurrentSessionBinding } from "../utils/teams";

/** Durable Team implementation of Task authority's narrow mutation boundary. */
export class DurableTaskAuthorityTeam implements TaskAuthorityTeamPort {
  async binding(teamName: string): Promise<TaskAuthorityBinding> {
    const config = await readConfig(teamName);
    if (config.taskBackend !== "beads" || !config.taskWorkspace || !config.taskAuthorityId || !config.taskAuthorityFingerprint) {
      throw new Error(`Team ${config.name} has no complete Beads Task authority binding.`);
    }
    return { teamName: config.name, workspace: config.taskWorkspace, authorityFingerprint: config.taskAuthorityFingerprint };
  }

  async withCurrentActor<T>(input: { teamName: string; actor: string; sessionFile: string; membershipId?: string }, action: (binding: TaskAuthorityBinding) => Promise<T>): Promise<T> {
    const membershipId = input.membershipId || (await assertCurrentSessionBinding(input.teamName, input.actor, input.sessionFile)).membershipId;
    if (!membershipId) throw new Error(`Current Membership for ${input.actor} on team ${input.teamName} has no membershipId.`);
    return withCurrentSessionBinding(input.teamName, input.actor, input.sessionFile, membershipId, async () => action(await this.binding(input.teamName)));
  }
}
