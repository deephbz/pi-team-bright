import type { TaskAuthorityBinding, TaskAuthorityTeamPort } from "../../src/task-authority/contracts";
import { assertCurrentSessionBinding, readConfig, withCurrentSessionBinding } from "../../src/utils/teams";

export type TaskAuthorityTeamPortOverrides = Partial<TaskAuthorityTeamPort>;

/**
 * Test-only explicit Task authority boundary. Defaults use the Team fixture's
 * durable binding, while overrides expose binding and actor-fence behavior.
 */
export function createTaskAuthorityTeamPort(overrides: TaskAuthorityTeamPortOverrides = {}): TaskAuthorityTeamPort {
  const binding = overrides.binding ?? (async (teamName: string): Promise<TaskAuthorityBinding> => {
    const config = await readConfig(teamName);
    if (config.taskBackend !== "beads" || !config.taskWorkspace || !config.taskAuthorityId || !config.taskAuthorityFingerprint) {
      throw new Error(`Team ${config.name} has no complete Beads Task authority binding.`);
    }
    return { teamName: config.name, workspace: config.taskWorkspace, authorityFingerprint: config.taskAuthorityFingerprint };
  });
  return {
    binding,
    withCurrentActor: overrides.withCurrentActor ?? (async (input, action) => {
      const membershipId = input.membershipId
        || (await assertCurrentSessionBinding(input.teamName, input.actor, input.sessionFile)).membershipId;
      if (!membershipId) throw new Error(`Current Membership for ${input.actor} on team ${input.teamName} has no membershipId.`);
      return withCurrentSessionBinding(input.teamName, input.actor, input.sessionFile, membershipId, async () =>
        action(await binding(input.teamName)));
    }),
  };
}
