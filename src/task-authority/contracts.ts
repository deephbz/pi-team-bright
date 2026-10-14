/** Historical Task journal evidence remains readable across authority changes. */
export interface ModelToolTaskJournalEntry {
  id: string;
  at: string;
  actor: string;
  kind: "progress" | "decision" | "blocker" | "result" | "note";
  text: string;
}

/** Status and relation vocabulary of historical Task records. */
export type TaskStatus = "open" | "in_progress" | "blocked" | "closed";
export type TaskRelationType = "parent" | "blocked_by" | "related";
export interface TaskRelation {
  relation: TaskRelationType;
  targetId: string;
}
