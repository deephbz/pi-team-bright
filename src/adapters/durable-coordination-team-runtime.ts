import { legacyCarrierAttention } from "../carrier-observation";
import { hostEnv } from "../env/host-env";
import { currentDeliveryDegradations, verifyRuntimeGeneration, readRuntimeStatus } from "../utils/runtime";
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
    const probe = status.pid ? hostEnv().process.generation(status.pid) : { kind: "unknown" as const, reason: "runtime_missing" };
    const attention = legacyCarrierAttention(member, status, probe);
    const deliveryDegraded = currentDeliveryDegradations(member, status, verifyRuntimeGeneration(status, probe));
    return {
      ...(deliveryDegraded.length ? { deliveryDegraded } : {}),
      ...(attention ? { attention } : {}),
      ...(status.membershipId !== undefined ? { membershipId: status.membershipId } : {}),
      ...(status.pid !== undefined ? { pid: status.pid } : {}),
      ...(status.startedAt !== undefined ? { startedAt: status.startedAt } : {}),
      // Self-reported settlement cannot outlive its verified process generation.
      ...(verifyRuntimeGeneration(status, probe) === "live" && !status.lastStop && status.runState !== undefined ? { runState: status.runState } : {}),
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
      ...(config.syncLiveness ? { syncLiveness: {
        waitSeconds: config.syncLiveness.waitSeconds,
        autoSyncEnabled: config.syncLiveness.autoSyncEnabled,
        autoSyncDelaySeconds: config.syncLiveness.autoSyncDelaySeconds,
        autoSyncUpdateThreshold: config.syncLiveness.autoSyncUpdateThreshold,
        nudgeEnabled: config.syncLiveness.nudgeEnabled,
        nudgeDelaySeconds: config.syncLiveness.nudgeDelaySeconds,
        policyVersion: config.syncLiveness.policyVersion,
      } } : {}),
      members: config.members.map((member) => ({
        name: member.name,
        agentType: member.agentType,
        membershipId: member.membershipId,
        pendingLaunchId: member.pendingLaunchId,
        sessionFile: member.sessionFile,
        isActive: member.isActive,
      })),
      logicalWorkers: config.logicalWorkers?.map((worker) => ({ name: worker.name, scope: worker.scope })),
    };
  }
}
