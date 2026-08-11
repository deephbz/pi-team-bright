/** Consumer-owned Task queries that protect Team lifecycle transitions. */
export interface AssignedWorkGuard {
  /** Whole-Team query used only after Team shutdown actuation. */
  nonterminalTaskIds(teamName: string): Promise<string[]>;
  /** Exact-Worker query used before one Worker carrier can stop. */
  nonterminalTaskIdsAssignedToWorker(teamName: string, workerName: string): Promise<string[]>;
}

/** Native authority query for one Worker's nonterminal assigned Tasks. */
export interface NonterminalAssignedTaskQuery {
  nonterminalTaskIdsAssignedToWorker(teamName: string, workerName: string): Promise<string[]>;
}
