import type { TaskCard } from "./task-domain";
import type { TaskVersionRef } from "./task-version-ref";
export interface TaskAuthorityBinding {
    teamName: string;
    workspace: string;
    authorityFingerprint: unknown;
}
/** Task-owned live Team boundary for mutation-capable Beads authority calls. */
export interface TaskAuthorityTeamPort {
    binding(teamName: string): Promise<TaskAuthorityBinding>;
    withCurrentActor<T>(input: {
        teamName: string;
        actor: string;
        sessionFile: string;
        membershipId?: string;
    }, action: (binding: TaskAuthorityBinding) => Promise<T>): Promise<T>;
}
/** Task-owned Team binding boundary for read-only native authority calls. */
export interface TaskAuthorityReadTeamPort {
    readBinding(teamName: string): Promise<TaskAuthorityBinding>;
}
/** Task-owned read boundary over one Team-scoped native authority. */
export interface TaskAuthorityReadPort<TaskAuthorityRecord> {
    readTaskAuthorityRecordEnvelope(teamName: string, taskId: string): Promise<TaskAuthorityRecord>;
    readTaskAuthorityRecordEnvelopes(teamName: string, taskIds: readonly string[]): Promise<Array<TaskAuthorityRecord | undefined>>;
    listTaskIds(teamName: string): Promise<string[]>;
}
export type TaskStatus = "open" | "in_progress" | "blocked" | "closed";
export type TaskRelationType = "parent" | "blocked_by" | "related";
export interface TaskRelation {
    relation: TaskRelationType;
    targetId: string;
}
/** Canonical Task update command consumed by Task authority. */
export interface ModelToolTaskUpdateInput {
    taskId: string;
    operationId: string;
    expectedVersion: TaskVersionRef;
    currentContext?: string;
    journalEntries?: Array<{
        kind: "progress" | "decision" | "blocker" | "result" | "note";
        text: string;
    }>;
    status?: "open" | "in_progress" | "blocked" | "closed";
}
/** Canonical Task journal evidence projected from committed Task events. */
export interface ModelToolTaskJournalEntry {
    id: string;
    at: string;
    actor: string;
    kind: "progress" | "decision" | "blocker" | "result" | "note";
    text: string;
}
export type TaskReconciliationReadOutcome = {
    kind: "found";
    task: TaskCard;
} | {
    kind: "contract_gap";
    reason: "task_metadata_absent" | "task_metadata_invalid";
    taskId: string;
    version: TaskVersionRef;
    message: string;
} | undefined;
/**
 * Task-owned query boundary used only to rebuild delivery evidence.
 * Implementations bind one Team-scoped authority at the composition root.
 */
export interface TaskReconciliationQuery {
    readOwnerTransitionEvidence(taskId: string): Promise<{
        task: TaskCard;
        operationId?: string;
    }>;
    readCurrentTasks(): Promise<TaskReconciliationReadOutcome[]>;
}
