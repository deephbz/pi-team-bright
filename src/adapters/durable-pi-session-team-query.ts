import type {
  PiSessionCurrentBinding,
  PiSessionResumeBinding,
  PiSessionTeamQueryPort,
  PiSessionWorkerBinding,
  PiSessionWorkerProfile,
} from "../team-authority/pi-session-team-query";
import {
  assertCurrentSessionBinding,
  findLeadTeamForSession,
  findTeammateBySessionFile,
  readConfig,
  resolveCurrentTeammateSessionBinding,
  teamExists,
} from "../utils/teams";

/** Durable Team-record adapter for Pi Session hook reads. */
export class DurablePiSessionTeamQuery implements PiSessionTeamQueryPort {
  findLeadTeamForSession(sessionFile?: string): string | null {
    return findLeadTeamForSession(sessionFile);
  }

  findTeammateBySessionFile(sessionFile: string): PiSessionResumeBinding | null {
    const binding = findTeammateBySessionFile(sessionFile);
    return binding ? {
      teamName: binding.teamName,
      member: { name: binding.member.name, membershipId: binding.member.membershipId },
    } : null;
  }

  async resolveCurrentTeammateSessionBinding(sessionFile: string): Promise<PiSessionWorkerBinding> {
    const binding = await resolveCurrentTeammateSessionBinding(sessionFile);
    return binding.status === "bound" ? {
      status: "bound",
      teamName: binding.teamName,
      member: {
        name: binding.member.name,
        membershipId: binding.member.membershipId,
        sessionFile: binding.member.sessionFile,
      },
    } : binding;
  }

  teamExists(teamName: string): boolean {
    return teamExists(teamName);
  }

  async currentSessionBinding(teamName: string, memberName: string, sessionFile: string): Promise<PiSessionCurrentBinding> {
    const member = await assertCurrentSessionBinding(teamName, memberName, sessionFile);
    return { membershipId: member.membershipId };
  }

  async terminalPlacement(teamName: string) {
    const config = await readConfig(teamName);
    return { name: config.name, terminalBackend: config.terminalBackend };
  }

  async syncNudgePolicy(teamName: string) {
    return (await readConfig(teamName)).syncLiveness;
  }

  async matchesSyncNudgeCandidate(input: {
    teamName: string;
    teamEpochId: string;
    leaderSessionFile: string;
    leaderMembershipId: string;
  }): Promise<boolean> {
    const config = await readConfig(input.teamName);
    if (config.epochId !== input.teamEpochId || config.leadSessionId !== input.leaderSessionFile) return false;
    const leader = await assertCurrentSessionBinding(input.teamName, "team-lead", input.leaderSessionFile);
    return leader.membershipId === input.leaderMembershipId;
  }

  async workerProfile(teamName: string, workerName: string): Promise<PiSessionWorkerProfile | null> {
    const member = (await readConfig(teamName)).members.find((candidate) =>
      candidate.name === workerName && candidate.isActive !== false,
    );
    return member ? { prompt: member.prompt, model: member.model, thinking: member.thinking } : null;
  }

  async activeMembershipId(teamName: string, memberName: string): Promise<string | undefined> {
    return (await readConfig(teamName)).members.find((member) =>
      member.name === memberName && member.isActive !== false,
    )?.membershipId;
  }
}
