import type { Member, TeamConfig, TerminalTarget } from "./models";
import { memberTerminalTarget } from "./terminal-target";
import type { TeamPanePlacement } from "./terminal-adapter";

function paneTarget(config: TeamConfig, backend: string, member: Member, role: string): string {
  const target = memberTerminalTarget(member, config.terminalBackend ?? backend);
  if (!target || target.backend !== backend || target.kind !== "pane") {
    throw new Error(`${role} ${member.name} has no exact ${backend} pane target; refusing Worker spawn.`);
  }
  return target.targetId;
}

/**
 * Derive one Team-only pane placement from durable Membership targets. Adapters
 * must not replace any of these IDs with the focused or ambient terminal pane.
 */
export function teamPanePlacement(
  config: TeamConfig,
  backend: string,
  excludeMembershipId?: string,
): TeamPanePlacement {
  const lead = config.members.find((member) => member.agentType === "lead" && member.isActive !== false);
  if (!lead) throw new Error(`Team ${config.name} has no current leader pane target; refusing Worker spawn.`);
  const leaderPaneId = paneTarget(config, backend, lead, "Team leader");
  const workerPaneIds = config.members
    .filter((member) => member.agentType === "teammate" && member.isActive !== false && member.membershipId !== excludeMembershipId)
    .map((member) => paneTarget(config, backend, member, "Current Team Worker"));

  if (workerPaneIds.includes(leaderPaneId) || new Set(workerPaneIds).size !== workerPaneIds.length) {
    throw new Error(`Team ${config.name} has overlapping pane targets; refusing Worker spawn.`);
  }

  return { leaderPaneId, workerPaneIds, paneLayout: config.paneLayout };
}
