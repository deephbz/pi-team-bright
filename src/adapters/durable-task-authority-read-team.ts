import type { TaskAuthorityBinding, TaskAuthorityReadTeamPort } from "../task-authority/contracts";

import { readConfig } from "../utils/teams";

/** Durable Team implementation of Task authority's read-only binding boundary. */
export class DurableTaskAuthorityReadTeam implements TaskAuthorityReadTeamPort {
  async readBinding(teamName: string): Promise<TaskAuthorityBinding> {
    const config = await readConfig(teamName);
    if (config.taskBackend !== "beads") {
      const target = process.env.PI_TEAMS_BEADS_WORKSPACE?.trim() || "<absolute-beads-workspace>";
      throw new Error(`Team ${teamName} still uses legacy JSON Task authority. Run: npm run migrate:tasks -- ${teamName} ${target}`);
    }
    if (!config.taskWorkspace) {
      throw new Error(`Team ${teamName} is configured for Beads but has no taskWorkspace. Re-run migration configuration; legacy task files are not a fallback.`);
    }
    if (!config.taskAuthorityId || !config.taskAuthorityFingerprint) {
      throw new Error(`Team ${teamName} has an incomplete Beads Task authority binding.`);
    }
    return { teamName, workspace: config.taskWorkspace, authorityFingerprint: config.taskAuthorityFingerprint };
  }
}
