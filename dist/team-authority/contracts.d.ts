export declare const THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh"];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export interface TerminalTarget {
    /** Stable registry ID of the backend that owns this target. */
    backend: string;
    kind: "pane" | "window";
    targetId: string;
}
export interface Member {
    /** Unique identity for this one Team membership generation. */
    membershipId?: string;
    /** Single-use capability accepted only while this generation is unbound. */
    pendingLaunchId?: string;
    launchConsumedAt?: string;
    agentId: string;
    name: string;
    agentType: string;
    model?: string;
    joinedAt: number;
    /** Backend-qualified terminal carrier for this Membership generation. */
    terminalTarget?: TerminalTarget;
    /** Legacy unqualified pane field; new writes use terminalTarget. */
    tmuxPaneId?: string;
    /** Durable Pi session identity, recorded after the teammate's first start. */
    sessionFile?: string;
    /** Legacy unqualified window field; new writes use terminalTarget. */
    windowId?: string;
    cwd: string;
    subscriptions: any[];
    prompt?: string;
    color?: string;
    thinking?: ThinkingLevel;
    isActive?: boolean;
    /** Durable lifecycle evidence; inactive members remain historical identities. */
    deactivatedAt?: string;
    deactivationReason?: "team_shutdown" | "process_shutdown" | "replaced";
}
/** Historical Team import path for Task-owned Beads identity evidence. */
export type { BeadsAuthorityFingerprint } from "../task-authority/team-config-task-authority";
export interface LogicalWorker {
    /** Stable Worker identity within one Team, independent of carrier generations. */
    name: string;
    /** Durable semantic area owned by this Worker, not its current Task. */
    scope: string;
}
/**
 * Historical TeamConfig import path. The mixed persisted record is composed in
 * the compatibility seam from Team, Coordination, and Task-owned field sets.
 */
export type { TeamConfig } from "./team-config-compatibility";
