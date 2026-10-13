import type { TaskTeamEvent, TeamEvent, TeamEventInput, TeamEventType } from "./contracts";
import type { TeamConfig } from "../team-authority/contracts";
import { type CanonicalTaskCard } from "../task-authority/task-domain";
import { type TaskVersionRef } from "../task-authority/task-version-ref";
export declare const DEFAULT_TEAM_SYNC_LIMIT = 50;
export declare const MAX_TEAM_SYNC_LIMIT = 100;
export interface TeamEventReadOptions {
    afterCursor?: string;
    eventTypes?: readonly TeamEventType[];
    taskIds?: readonly string[];
    limit?: number;
}
export type TaskEventEvidenceKind = "created" | "goal" | "assignment" | "progress" | "status" | "relation" | "decision" | "blocker" | "result" | "note";
export interface TaskEventEvidenceInput {
    kind: TaskEventEvidenceKind;
    text: string;
}
export interface TaskEvidenceTeamEvent extends TaskTeamEvent {
    taskEvidence: TaskEventEvidenceInput;
}
export interface ProjectedTaskEventEvidence extends TaskEventEvidenceInput {
    id: string;
    at: string;
    actor: string;
}
export interface TaskActivityCoordinate {
    taskId: string;
    cursor: string;
    /** First committed Task event observed in this Team journal. */
    firstActivityAt: string;
    /** Latest committed Task event observed in this Team journal. */
    lastActivityAt: string;
}
export interface TaskActivityProjection {
    headCursor: string;
    /** One latest committed activity coordinate per Task, newest first. */
    tasks: TaskActivityCoordinate[];
}
export interface TeamEventBatch {
    /** Safe continuation position. It advances to journal head unless truncated. */
    cursor: string;
    /** Current global journal head, which can be ahead of cursor when truncated. */
    headCursor: string;
    events: TeamEvent[];
    truncated: boolean;
    /** Matching records after the returned page, not a numeric cursor gap. */
    remaining: number;
}
export interface TeamEventWaitOptions extends TeamEventReadOptions {
    teamName: string;
    waitMs?: number;
    signal?: AbortSignal;
}
export interface TeamEventWaitResult extends TeamEventBatch {
    timedOut: boolean;
}
export interface TeamTaskSummary {
    id: string;
    title: string;
    status: CanonicalTaskCard["status"];
    assignee?: string;
    version?: TaskVersionRef;
}
export interface TeamWorkerProjection {
    name: string;
    membershipId?: string;
    carrier: "prepared" | "session_bound" | "absent";
    nonterminalTasks: Array<{
        id: string;
        status: CanonicalTaskCard["status"];
    }>;
}
export interface TeamCurrentProjection {
    team: {
        name: string;
        description: string;
        lifecycle: "active" | "stopped";
        taskAuthority?: {
            backend: "beads";
            authorityId: string;
        };
    };
    workers: TeamWorkerProjection[];
    tasks: TeamTaskSummary[];
}
export interface TeamProjectionPage {
    projection: TeamCurrentProjection;
    offset: number;
    limit: number;
    totalItems: number;
    truncated: boolean;
    continuation?: string;
}
export declare class TeamEventCursorAheadError extends Error {
    readonly requestedCursor: string;
    readonly headCursor: string;
    readonly name = "TeamEventCursorAheadError";
    constructor(requestedCursor: string, headCursor: string);
}
export declare class InvalidTeamSnapshotContinuationError extends Error {
    readonly name = "InvalidTeamSnapshotContinuationError";
}
/**
 * Append one observation after its owning authority commits. The JSONL is the
 * evidence authority; cursor.json is only a rebuildable latest-position view.
 */
export declare function appendTeamEvent(teamName: string, input: TeamEventInput): Promise<TeamEvent>;
/** Append structured Task evidence and return its committed identity/time. */
export declare function appendTaskEvidenceEvent(teamName: string, input: Omit<TaskTeamEvent, "cursor" | "at"> & {
    taskEvidence: TaskEventEvidenceInput;
}): Promise<TaskEvidenceTeamEvent>;
/** Project only committed event coordinates; caller prose never supplies IDs or time. */
export declare function projectTaskEventEvidence(event: TeamEvent): ProjectedTaskEventEvidence | undefined;
/** Non-consuming read: each caller owns its supplied cursor. */
export declare function readTeamEvents(teamName: string, options?: TeamEventReadOptions): TeamEventBatch;
/** Read one journal image and split unseen events into bounded observation pages. */
export declare function readTeamEventPages(teamName: string, options?: Pick<TeamEventReadOptions, "afterCursor" | "limit">): TeamEventBatch[];
export declare function readTeamEventCursor(teamName: string): string;
/**
 * Read the journal once and project only latest per-Task activity coordinates.
 * This is ordering evidence for derived views, not Task state authority.
 */
export declare function readTaskActivity(teamName: string): TaskActivityProjection;
/** Event-driven check-register-check wait; filesystem notifications are hints. */
export declare function waitForTeamEvents(options: TeamEventWaitOptions): Promise<TeamEventWaitResult>;
/** Snapshot mode returns the current cursor without replaying history. */
export declare function syncTeamEvents(options: TeamEventWaitOptions & {
    cursor?: string;
}): Promise<TeamEventWaitResult>;
/**
 * Build the compact current projection from authoritative records already read
 * by the caller. This stays pure so the event journal never imports the Task
 * adapter and Task mutations can append events without a dependency cycle.
 */
export declare function projectTeamCurrentState(config: TeamConfig, tasks: ReadonlyArray<CanonicalTaskCard>): TeamCurrentProjection;
/** Bound a compact snapshot and return an opaque continuation pinned to its event head. */
export declare function pageTeamCurrentProjection(projection: TeamCurrentProjection, options: {
    headCursor: string;
    limit?: number;
    continuation?: string;
}): TeamProjectionPage;
/** Hydrate changed/requested Task references from their current authority state. */
export declare function hydrateTeamSyncTasks(events: readonly TeamEvent[], requestedTaskIds: readonly string[] | undefined, readTasks: (taskIds: readonly string[]) => Promise<CanonicalTaskCard[]>): Promise<CanonicalTaskCard[]>;
