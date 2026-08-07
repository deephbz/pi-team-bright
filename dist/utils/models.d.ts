import type { TeamPaneLayout } from "./team-pane-layout";
import type { TaskVersionRef } from "../model-tool-contract/task-version-ref";
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
/** Versioned external identity evidence for one Beads 1.1 authority. */
export interface BeadsAuthorityFingerprint {
    schema: "pi-teams-beads-authority/1";
    backend: "dolt";
    database: "dolt";
    doltDatabase: string;
    projectId: string;
}
export interface LogicalWorker {
    /** Stable Worker identity within one Team, independent of carrier generations. */
    name: string;
    /** Durable semantic area owned by this Worker, not its current Task. */
    scope: string;
}
export interface TeamConfig {
    name: string;
    description: string;
    createdAt: number;
    leadAgentId: string;
    leadSessionId: string;
    /** Opaque identity for this stopped/restarted Team epoch. Absent on legacy records. */
    epochId?: string;
    /** Public coordination implementation fence. Absent on legacy records. */
    implementationVersion?: string;
    /** Stable logical Workers. Absent on legacy records; Memberships remain carriers. */
    logicalWorkers?: LogicalWorker[];
    members: Member[];
    defaultModel?: string;
    separateWindows?: boolean;
    /** Resolved once at Team creation; live epochs do not follow later settings changes. */
    paneLayout?: TeamPaneLayout;
    /** Resolved Team-sync liveness policy for this epoch. */
    syncLiveness?: {
        waitSeconds: number;
        nudgeEnabled: boolean;
        nudgeDelaySeconds?: number;
        policyVersion: string;
        diagnostics?: string[];
    };
    /** One terminal backend owns every current Member target in this Team epoch. */
    terminalBackend?: string;
    /** Task authority. Omitted means the historical local JSON store. */
    taskBackend?: "legacy" | "beads";
    /** Stable opaque authority identity; independent of workspace path spelling. */
    taskAuthorityId?: string;
    /** Canonical external evidence binding the opaque identity to one Beads DB. */
    taskAuthorityFingerprint?: BeadsAuthorityFingerprint;
    /** Absolute working directory containing the team's initialized Beads repo. */
    taskWorkspace?: string;
    /** Durable evidence for the one-way legacy -> Beads cutover. */
    taskCutover?: {
        inventoryPath: string;
        inventorySha256: string;
        markerPath?: string;
        cutoverAt: string;
    };
}
export type TaskStatus = "open" | "in_progress" | "blocked" | "closed";
export type TaskRelationType = "parent" | "blocked_by" | "related";
export interface TaskRelation {
    relation: TaskRelationType;
    targetId: string;
}
export type TeamEventType = "task" | "worker" | "alert";
export type TaskEventChange = "created" | "assigned" | "goal" | "note" | "status" | "relation";
export interface TaskTeamEvent {
    type: "task";
    cursor: string;
    ref: {
        taskId: string;
        version: TaskVersionRef;
    };
    change: TaskEventChange;
    actor: string;
    at: string;
}
export type WorkerEventPhase = "prepared" | "session_bound" | "stopped" | "failed";
export interface WorkerRuntimeGenerationEvidence {
    membershipId: string;
    pid: number;
    startedAt: number;
}
export interface WorkerTeamEvent {
    type: "worker";
    cursor: string;
    worker: string;
    membershipId: string;
    phase: WorkerEventPhase;
    /** Absent on legacy journal records; required for new session_bound evidence. */
    generation?: WorkerRuntimeGenerationEvidence;
    at: string;
}
export type AlertKind = "clarification" | "attention" | "announcement";
export interface AlertTeamEvent {
    type: "alert";
    cursor: string;
    alertId: string;
    from: string;
    to: string | "*";
    taskRef?: {
        taskId: string;
        version?: TaskVersionRef;
    };
    kind: AlertKind;
    text: string;
    at: string;
}
/** Ordered observation of committed state; it is not a second Task or Worker authority. */
export type TeamEvent = TaskTeamEvent | WorkerTeamEvent | AlertTeamEvent;
export type TeamEventInput = Omit<TaskTeamEvent, "cursor" | "at"> | Omit<WorkerTeamEvent, "cursor" | "at"> | Omit<AlertTeamEvent, "cursor" | "at">;
export interface InboxMessage {
    /** Communication-authority identity. Optional only for legacy on-disk records. */
    id?: string;
    /** Exact destination membership generation. Absent only on historical legacy records. */
    recipientMembershipId?: string;
    /** Exact sender membership generation when the sender is a current Team member. */
    senderMembershipId?: string;
    from: string;
    text: string;
    timestamp: string;
    read: boolean;
    summary?: string;
    color?: string;
}
/** An inbox Message after the storage boundary has assigned or migrated its ID. */
export interface IdentifiedInboxMessage extends InboxMessage {
    id: string;
}
