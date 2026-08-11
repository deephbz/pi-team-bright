import type { TeamConfig } from "./contracts";

/** Coordinates needed to restore a Worker from its durable Pi Session. */
export interface PiSessionResumeMember {
  name: string;
  membershipId?: string;
}

export interface PiSessionResumeBinding {
  teamName: string;
  member: PiSessionResumeMember;
}

/** Exact current Worker coordinates needed by Worker tool callers. */
export interface PiSessionCurrentWorkerMember {
  name: string;
  membershipId?: string;
  sessionFile?: string;
}

export type PiSessionWorkerBinding =
  | { status: "bound"; teamName: string; member: PiSessionCurrentWorkerMember }
  | {
    status: "abstain";
    reason:
      | "not_bound"
      | "leader_or_non_teammate"
      | "unverified_generation"
      | "ambiguous_binding"
      | "runtime_metadata_unavailable"
      | "stale_binding";
  };

/** Current Membership coordinate needed by Session delivery and status checks. */
export interface PiSessionCurrentBinding {
  membershipId?: string;
}

export interface PiSessionWorkerProfile {
  prompt?: string;
  model?: string;
  thinking?: string;
}

/** Pi Session adapter's read-only Team boundary. */
export interface PiSessionTeamQueryPort {
  findLeadTeamForSession(sessionFile?: string): string | null;
  findTeammateBySessionFile(sessionFile: string): PiSessionResumeBinding | null;
  resolveCurrentTeammateSessionBinding(sessionFile: string): Promise<PiSessionWorkerBinding>;
  teamExists(teamName: string): boolean;
  currentSessionBinding(teamName: string, memberName: string, sessionFile: string): Promise<PiSessionCurrentBinding>;
  terminalPlacement(teamName: string): Promise<Pick<TeamConfig, "name" | "terminalBackend">>;
  syncNudgePolicy(teamName: string): Promise<TeamConfig["syncLiveness"] | undefined>;
  matchesSyncNudgeCandidate(input: {
    teamName: string;
    teamEpochId: string;
    leaderSessionFile: string;
    leaderMembershipId: string;
  }): Promise<boolean>;
  workerProfile(teamName: string, workerName: string): Promise<PiSessionWorkerProfile | null>;
  activeMembershipId(teamName: string, memberName: string): Promise<string | undefined>;
}
