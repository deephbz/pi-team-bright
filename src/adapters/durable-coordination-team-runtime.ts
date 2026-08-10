import { readRuntimeStatus } from "../utils/runtime";
import { readConfig, resolveCurrentLeadSessionBinding } from "../utils/teams";
import type {
  CoordinationMemberEvidence,
  CoordinationRuntimeEvidence,
  CoordinationTeamRuntimeQuery,
} from "../coordination/queries";

/** Durable Team/runtime adapter for Coordination liveness evidence. */
export class DurableCoordinationTeamRuntimeQuery implements CoordinationTeamRuntimeQuery {
  async readRuntime(teamName: string, member: CoordinationMemberEvidence): Promise<CoordinationRuntimeEvidence | null> {
    const status = await readRuntimeStatus(teamName, member.name);
    if (!status) return null;
    return {
      ...(status.membershipId !== undefined ? { membershipId: status.membershipId } : {}),
      ...(status.pid !== undefined ? { pid: status.pid } : {}),
      ...(status.startedAt !== undefined ? { startedAt: status.startedAt } : {}),
      ...(status.runState !== undefined ? { runState: status.runState } : {}),
    };
  }

  async readLeaderBinding(sessionFile: string) {
    const binding = await resolveCurrentLeadSessionBinding(sessionFile);
    if (binding.status !== "bound") return undefined;
    const config = await readConfig(binding.teamName);
    return {
      teamName: binding.teamName,
      purpose: config.description,
      epochId: config.epochId,
      sessionFile,
      ...(config.syncLiveness ? { syncLiveness: { waitSeconds: config.syncLiveness.waitSeconds } } : {}),
      members: config.members.map((member) => ({
        name: member.name,
        membershipId: member.membershipId,
        pendingLaunchId: member.pendingLaunchId,
        sessionFile: member.sessionFile,
        isActive: member.isActive,
      })),
      logicalWorkers: config.logicalWorkers?.map((worker) => ({ name: worker.name, scope: worker.scope })),
    };
  }
}
