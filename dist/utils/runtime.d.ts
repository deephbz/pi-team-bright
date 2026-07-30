import type { Member } from "./models";
/**
 * Runtime constants for health checking.
 * Exported for configurability and testing.
 */
export declare const HEARTBEAT_STALE_MS = 90000;
export declare const STARTUP_STALL_MS = 60000;
export declare const RUNTIME_STALE_MS = 300000;
/**
 * Structured error information for better diagnostics.
 */
export interface RuntimeError {
    message: string;
    timestamp: number;
}
export interface AgentRuntimeStatus {
    teamName: string;
    agentName: string;
    membershipId?: string;
    pid?: number;
    startedAt?: number;
    lastHeartbeatAt?: number;
    lastInboxReadAt?: number;
    ready?: boolean;
    lastError?: RuntimeError;
}
/** Exact ephemeral process generation within one durable Membership. */
export interface RuntimeGeneration {
    membershipId: string;
    pid: number;
    startedAt: number;
}
export declare function runtimeGeneration(status: AgentRuntimeStatus | null): RuntimeGeneration | null;
/** One current Membership admits one live Pi process generation. */
export type RuntimeStartupAdmission = {
    kind: "admitted";
    action: "claim" | "already_current";
    replaces?: RuntimeGeneration;
} | {
    kind: "refused";
    reason: string;
};
/** ESRCH is the only bounded proof that a recorded PID is absent. */
export declare function probePidPresence(pid: number): "absent" | "occupied";
/**
 * Decide startup admission under the exact Membership mutation lease. Runtime
 * status is authoritative only for this bounded process-generation decision.
 */
export declare function admitRuntimeStartup(member: Pick<Member, "name" | "membershipId" | "sessionFile" | "pendingLaunchId">, sessionFile: string, status: AgentRuntimeStatus | null, pid?: number, probe?: (pid: number) => "absent" | "occupied", launchId?: string): RuntimeStartupAdmission;
/**
 * Write runtime status for an agent. Merges with existing status.
 */
export declare function writeRuntimeStatus(teamName: string, agentName: string, updates: Partial<AgentRuntimeStatus>, membershipId?: string): Promise<AgentRuntimeStatus>;
/**
 * Read runtime status for an agent. Returns null if not found.
 */
export declare function readRuntimeStatus(teamName: string, agentName: string): Promise<AgentRuntimeStatus | null>;
/**
 * Delete runtime status for an agent. Called during shutdown.
 */
export declare function deleteRuntimeStatus(teamName: string, agentName: string, expected: RuntimeGeneration): Promise<boolean>;
/**
 * Clean up stale runtime files for a team.
 * Removes files older than RUNTIME_STALE_MS that have no recent heartbeat.
 * Returns the number of files cleaned up.
 */
export declare function cleanupStaleRuntimeFiles(teamName: string, now?: number): Promise<number>;
/**
 * Create a structured error object from an error.
 */
export declare function createRuntimeError(error: unknown): RuntimeError;
