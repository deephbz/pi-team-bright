import type { TaskAuthorityBinding, TaskAuthorityTeamPort } from "../../src/task-authority/contracts";
import { readConfig, withCurrentSessionBinding } from "../../src/utils/teams";

export type TaskAuthorityTeamPortOverrides = Partial<TaskAuthorityTeamPort>;

/**
 * Test-only explicit Task authority boundary. Defaults use the Team fixture's
 * durable binding, while overrides expose binding and actor-fence behavior.
 */
export function createTaskAuthorityTeamPort(overrides: TaskAuthorityTeamPortOverrides = {}): TaskAuthorityTeamPort {
  const binding = overrides.binding ?? (async (teamName: string): Promise<TaskAuthorityBinding> => {
    const config = await readConfig(teamName);
    if (!config.taskWorkspace || !config.taskAuthorityFingerprint) {
      throw new Error(`Team ${teamName} has no Task authority fixture binding.`);
    }
    return {
      teamName: config.name,
      workspace: config.taskWorkspace,
      authorityFingerprint: config.taskAuthorityFingerprint,
    };
  });
  return {
    binding,
    withCurrentActor: overrides.withCurrentActor ?? (async (input, action) => {
      if (!input.membershipId) throw new Error(`Task authority fixture requires a Membership for ${input.actor}.`);
      return withCurrentSessionBinding(input.teamName, input.actor, input.sessionFile, input.membershipId, async () =>
        action(await binding(input.teamName)));
    }),
  };
}
