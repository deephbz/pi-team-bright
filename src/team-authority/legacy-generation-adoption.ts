import { hostEnv } from "../env/host-env";
import { herdrCarrierName } from "../adapters/herdr-adapter";
import { herdrList } from "../carrier-observation";
import { currentMembership, withCurrentMembershipLease } from "../utils/teams";
import { readRuntimeStatus, writeRuntimeStatus } from "../utils/runtime";

/** Human-only tokenless adoption. A prompt is not evidence; recheck after consent. */
export async function adoptLegacyGeneration(teamName: string, worker: string, expectedMembershipId: string): Promise<boolean> {
  const member = await currentMembership(teamName, worker);
  if (member.membershipId !== expectedMembershipId || !member.sessionFile) return false;
  const status = await readRuntimeStatus(teamName, worker);
  if (!status?.pid || status.osBirthToken || status.lastStop || status.membershipId !== expectedMembershipId) return false;
  const before = hostEnv().process.generation(status.pid);
  if (before.kind !== "found") return false;
  const agents = await herdrList("agent");
  const pane = member.terminalTarget?.targetId ?? member.tmuxPaneId;
  if (!agents?.some(row => row.name === herdrCarrierName(teamName, worker) && row.pane_id === pane && row.agent_session === member.sessionFile)) return false;
  return withCurrentMembershipLease(teamName, expectedMembershipId, async current => {
    const latest = await readRuntimeStatus(teamName, worker);
    if (current.sessionFile !== member.sessionFile || (current.terminalTarget?.targetId ?? current.tmuxPaneId) !== pane || !latest || latest.pid !== status.pid || latest.startedAt !== status.startedAt
      || latest.membershipId !== expectedMembershipId || latest.osBirthToken || latest.lastStop) return false;
    const after = hostEnv().process.generation(status.pid!);
    if (after.kind !== "found" || after.generation.osBirthToken !== before.generation.osBirthToken || after.generation.bootId !== before.generation.bootId) return false;
    await writeRuntimeStatus(teamName, worker, { osBirthToken: after.generation.osBirthToken, bootId: after.generation.bootId }, expectedMembershipId);
    return true;
  });
}
