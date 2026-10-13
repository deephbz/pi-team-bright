import type { BeadsAuthorityFingerprint, TeamConfig, Member, TerminalTarget, LogicalWorker } from "../team-authority/contracts";
import { type TeamPaneLayout } from "./team-pane-layout";
export interface CutoverMarker {
    state: "prepared" | "active";
    teamName?: string;
    inventoryPath: string;
    inventorySha256: string;
    workspace?: string;
    markerPath?: string;
    cutoverAt?: string;
}
/** Read the latest validated event from a migration marker. */
export declare function readLatestCutoverMarker(markerPath: string): CutoverMarker | undefined;
/** Refuse any new authority initialization when migration evidence outlived TeamConfig. */
export declare function assertNoOrphanedBeadsCutover(teamName: string): void;
export declare function teamExists(teamName: string): boolean;
export declare function newMembershipId(): string;
export declare function newLaunchId(): string;
export declare function newTeamEpochId(): string;
/** 600 lock attempts at 100 ms each: bounded to one minute. */
export declare const TEAM_TOPOLOGY_LEASE_RETRIES = 600;
export interface TeamTopologyLease {
    readonly teamName: string;
}
/**
 * Serialize lifecycle/topology transactions for one Team. Callers must take
 * exact Membership leases only inside this lease, preserving the global order
 * topology -> Membership -> TeamConfig. Different Teams remain independent.
 */
export declare function withTeamTopologyLease<T>(teamName: string, action: (lease: TeamTopologyLease) => Promise<T>, options?: {
    retries?: number;
}): Promise<T>;
export interface TeamTerminalBinding {
    backend: string;
    leadTarget?: TerminalTarget;
}
export declare function createTeam(name: string, sessionId: string, leadAgentId: string, description?: string, defaultModel?: string, separateWindows?: boolean, taskWorkspace?: string, taskAuthorityId?: string, taskAuthorityFingerprint?: BeadsAuthorityFingerprint, topologyLease?: TeamTopologyLease, terminalBinding?: TeamTerminalBinding, implementationVersion?: string, paneLayout?: TeamPaneLayout, syncLiveness?: TeamConfig["syncLiveness"]): Promise<TeamConfig>;
/** Persist TeamConfig without exposing a truncated target file. */
export declare function writeConfigAtomic(p: string, config: TeamConfig): void;
/** Find the team this durable Pi Session leads. */
export declare function findLeadTeamForSession(piSessionFile?: string): string | null;
/**
 * Locate a teammate by the Pi session file it registered on first startup.
 * Session files survive a new process launched with `pi -r`, unlike PIDs and
 * terminal pane IDs. Invalid or incomplete foreign team records are ignored
 * during discovery; their owning operation will surface a precise error.
 */
export declare function findTeammateBySessionFile(sessionFile: string): {
    teamName: string;
    member: Member;
} | null;
export type CurrentLeadSessionBindingResolution = {
    status: "bound";
    teamName: string;
    member: Member;
} | {
    status: "abstain";
    reason: "not_bound" | "ambiguous_binding" | "runtime_metadata_unavailable" | "stale_binding";
};
/**
 * Resolve one current lead Membership by exact durable Pi Session identity.
 * A strict scan and locked revalidation prevent filesystem order, names,
 * processes, terminal carriers, or a concurrently replaced epoch from binding.
 */
export declare function resolveCurrentLeadSessionBinding(sessionFile: string): Promise<CurrentLeadSessionBindingResolution>;
export type CurrentTeammateSessionBindingResolution = {
    status: "bound";
    teamName: string;
    member: Member;
} | {
    status: "abstain";
    reason: "not_bound" | "leader_or_non_teammate" | "unverified_generation" | "ambiguous_binding" | "runtime_metadata_unavailable" | "stale_binding";
};
/**
 * Resolve an operation-specific exact teammate binding without using names,
 * environment, process, pane, or launch metadata. A strict scan refuses to
 * claim uniqueness when Membership identity is unreadable, then the winning
 * Membership generation is revalidated under its mutation and config locks.
 */
export declare function resolveCurrentTeammateSessionBinding(sessionFile: string): Promise<CurrentTeammateSessionBindingResolution>;
export declare function readConfig(teamName: string): Promise<TeamConfig>;
/** Hold current membership/config stable across a dependent filesystem write. */
export declare function withCurrentConfig<T>(teamName: string, action: (config: TeamConfig) => Promise<T>): Promise<T>;
export type TeamModelToolContractGapReason = "team_epoch_missing" | "logical_workers_missing";
export interface TeamModelToolContractGap {
    kind: "contract_gap";
    reason: TeamModelToolContractGapReason;
}
/** Legacy TeamConfig remains readable, but model-tool state cannot infer missing authority coordinates. */
export declare function teamModelToolContractGap(config: TeamConfig): TeamModelToolContractGap | undefined;
export type ReadLogicalWorkerResult = {
    kind: "found";
    worker: LogicalWorker;
} | {
    kind: "not_found";
} | TeamModelToolContractGap;
/** Read one stable logical Worker without consulting Membership or carrier state. */
export declare function readLogicalWorker(teamName: string, workerName: string): Promise<ReadLogicalWorkerResult>;
export type EnsureLogicalWorkerResult = {
    kind: "created";
    worker: LogicalWorker;
} | {
    kind: "reused";
    worker: LogicalWorker;
} | {
    kind: "scope_conflict";
    worker: LogicalWorker;
} | TeamModelToolContractGap;
/**
 * Ensure durable Worker meaning under the TeamConfig lock. This operation does
 * not create, replace, inspect, or otherwise mutate Membership/carrier state.
 */
export declare function ensureLogicalWorker(teamName: string, input: LogicalWorker): Promise<EnsureLogicalWorkerResult>;
/** 600 lock attempts at 100 ms each: bounded to one minute. */
export declare const MEMBERSHIP_MUTATION_LEASE_RETRIES = 600;
/**
 * Serialize authority mutation and lifecycle transition for one exact
 * Membership generation without blocking unrelated team members. The lease
 * heartbeat is maintained by withLock, so a slow but live backend operation
 * cannot be mistaken for an abandoned writer.
 */
export declare function withMembershipMutationLease<T>(teamName: string, membershipId: string, action: () => Promise<T>, options?: {
    retries?: number;
}): Promise<T>;
/**
 * Hold one exact Membership generation's mutation lease, briefly revalidate
 * its Session binding under the TeamConfig lock, then release TeamConfig
 * before the external authority operation. Replacement and shutdown acquire
 * the same Membership lease, so no stale write can cross a generation while
 * unrelated members remain concurrent.
 */
export declare function withCurrentSessionBinding<T>(teamName: string, agentName: string, sessionFile: string, expectedMembershipId: string, action: (config: TeamConfig, member: Member) => Promise<T>): Promise<T>;
/**
 * Acquire the exact generation lease used by Task mutation, then verify that
 * generation is still current before a terminal/lifecycle side effect.
 */
export declare function withCurrentMembershipLease<T>(teamName: string, membershipId: string, action: (member: Member) => Promise<T>): Promise<T>;
export declare function currentMembership(teamName: string, agentName: string): Promise<Member>;
export declare function bindMemberSession(teamName: string, agentName: string, sessionFile: string, launchId?: string, updates?: Pick<Partial<Member>, "terminalTarget" | "tmuxPaneId" | "windowId">, expectedMembershipId?: string): Promise<Member>;
export declare function assertCurrentSessionBinding(teamName: string, agentName: string, sessionFile: string): Promise<Member>;
export declare function addMember(teamName: string, member: Member): Promise<void>;
export declare function deactivateMember(teamName: string, agentName: string, reason: NonNullable<Member["deactivationReason"]>): Promise<Member | null>;
/** Deactivate exactly one Membership generation; never resolve by reusable name. */
export declare function deactivateMembership(teamName: string, membershipId: string, reason: NonNullable<Member["deactivationReason"]>): Promise<Member | null>;
export declare function deactivateCurrentMembers(teamName: string, reason: NonNullable<Member["deactivationReason"]>): Promise<{
    deactivated: Member[];
    staleBindings: Member[];
}>;
export declare function updateMember(teamName: string, agentName: string, updates: Partial<Member>): Promise<void>;
export declare function updateMembership(teamName: string, membershipId: string, updates: Partial<Member>): Promise<Member>;
export declare function configureBeadsTaskBackend(teamName: string, taskWorkspace: string, taskAuthorityFingerprint: BeadsAuthorityFingerprint, taskCutover: NonNullable<TeamConfig["taskCutover"]>): Promise<TeamConfig>;
