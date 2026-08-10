/** Read-only Task guard for Team lifecycle transitions. */
export interface AssignedWorkGuard {
  nonterminalTaskIds(teamName: string, workerName?: string): Promise<string[]>;
}
