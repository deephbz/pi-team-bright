import type { TaskCard } from "../model-tool-contract/task-domain";
import type { TaskVersionRef } from "../model-tool-contract/task-version-ref";

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

export type TaskReconciliationReadOutcome =
  | { kind: "found"; task: TaskCard }
  | {
    kind: "contract_gap";
    reason: "task_metadata_absent" | "task_metadata_invalid";
    taskId: string;
    version: TaskVersionRef;
    message: string;
  }
  | undefined;

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
