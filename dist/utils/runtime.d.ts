import type { Member } from "../team-authority/contracts";
import type { DeliveryDegradation, DeliveryEngineName, DeliveryEngineState } from "./recipient-delivery-lifecycle";
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
    osBirthToken?: string;
    bootId?: string;
    startedAt?: number;
    lastHeartbeatAt?: number;
    lastInboxReadAt?: number;
    ready?: boolean;
    /** Exact Pi 0.83 agent lifecycle evidence for the current generation. */
    runState?: "active" | "settled";
    delivery?: {
        sessionFile: string;
        engines: Partial<Record<DeliveryEngineName, DeliveryEngineState>>;
    };
    lastError?: RuntimeError;
    lastStop?: {
        stopId?: string;
        piReason: "quit" | "reload" | "new" | "resume" | "fork";
        targetSessionFile?: string;
        observedAt: number;
        suspectedHumanStop: boolean;
    };
    stopRequested?: "worker_stop" | "team_shutdown" | "compensation";
}
/** Delivery observations apply only to this bound, verified process generation. */
export declare function currentDeliveryDegradations(member: Pick<Member, "membershipId" | "sessionFile">, status: AgentRuntimeStatus | null, verified?: "unknown" | "live" | "gone"): DeliveryDegradation[];
/** Exact ephemeral process generation within one durable Membership. */
export interface RuntimeGeneration {
    membershipId: string;
    pid: number;
    startedAt: number;
    osBirthToken?: string;
    bootId?: string;
}
/** Tokenless legacy records fail closed until their own process re-admits. */
export declare function verifyRuntimeGeneration(status: Pick<AgentRuntimeStatus, "pid" | "osBirthToken" | "bootId"> | null, observed?: import("../env/host-env").GenerationProbe): "live" | "gone" | "unknown";
export declare function ownBirthIdentity(): {
    osBirthToken?: string;
    bootId?: string;
};
export declare function runtimeGeneration(status: AgentRuntimeStatus | null): RuntimeGeneration | null;
/** One current Membership admits one live Pi process generation. */
export type RuntimeStartupAdmission = {
    kind: "admitted";
    action: "claim" | "already_current";
    replaces?: RuntimeGeneration;
} | {
    kind: "refused";
    reason: string;
    nextActionHint?: "ask_human";
};
/** A pure recovery check. Only the spawned child can claim and publish startup. */
export type RuntimeRecoveryPreflight = {
    kind: "ready";
    replaces?: RuntimeGeneration;
} | {
    kind: "refused";
    reason: string;
};
/** ESRCH is the only bounded proof that a recorded PID is absent. */
export declare function probePidPresence(pid: number): "absent" | "occupied";
/**
 * Check a missing carrier before its replacement process is spawned. This
 * never reserves, writes, or publishes a runtime generation.
 */
export declare function preflightRuntimeRecovery(member: Pick<Member, "name" | "membershipId" | "sessionFile" | "pendingLaunchId">, status: AgentRuntimeStatus | null, probe?: (pid: number) => "absent" | "occupied", launchId?: string): RuntimeRecoveryPreflight;
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
 * Restore an exact deleted runtime generation only when the runtime file is
 * still absent (or already contains that exact generation). A replacement is
 * never overwritten during shutdown compensation.
 */
export declare function restoreRuntimeStatus(teamName: string, agentName: string, status: AgentRuntimeStatus, expected: RuntimeGeneration): Promise<boolean>;
/** Delete only the exact runtime generation expected by shutdown/recovery. */
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
