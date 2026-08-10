/** Private, read-only decoder for recorded Team and runtime evidence. */
export type MembershipObservationDiagnosisCode = "membership_duplicate" | "session_locator_invalid" | "runtime_missing" | "runtime_malformed" | "runtime_legacy" | "runtime_generation_mismatch" | "runtime_unavailable" | "process_binding_ambiguous";
export type TeamObservationDiagnosisCode = "team_unreadable" | "team_config_missing" | "team_config_malformed" | "membership_malformed" | "team_changed_during_read";
export type SnapshotObservationDiagnosisCode = "teams_root_unavailable" | "projection_deadline_exceeded" | "projection_aborted";
export type MembershipObservationEvidence = {
    membershipId: string;
    memberName: string;
    coordinationRole: "lead" | "teammate";
    lifecycle: {
        state: "current";
        joinedAt: string;
    } | {
        state: "ended";
        joinedAt: string;
        endedAt?: string;
        reason?: unknown;
    };
    sessionLocator?: string;
    terminalTarget?: {
        backend: string;
        kind: "pane" | "window";
        targetId: string;
    };
    processBinding?: {
        membershipId: string;
        pid: number;
        processStartedAt: string;
    };
    readiness?: boolean;
    diagnoses: MembershipObservationDiagnosisCode[];
};
export type TeamObservationEvidence = {
    teamName: string;
    memberships: MembershipObservationEvidence[];
    diagnoses: TeamObservationDiagnosisCode[];
};
export type MembershipObservationRead = {
    teams: TeamObservationEvidence[];
    diagnoses: Array<{
        code: SnapshotObservationDiagnosisCode;
    } | {
        code: TeamObservationDiagnosisCode;
        teamName: string;
    }>;
};
export interface ReadMembershipObservationOptions {
    teamsRoot?: string;
    deadlineMs?: number;
    signal?: AbortSignal;
}
/** Read lock-free recorded Membership evidence. This module never writes Team or runtime records. */
export declare function readMembershipObservation(options?: ReadMembershipObservationOptions): Promise<MembershipObservationRead>;
