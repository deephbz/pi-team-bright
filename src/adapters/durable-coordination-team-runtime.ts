import { readRuntimeStatus } from "../utils/runtime";
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
}
