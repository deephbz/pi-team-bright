import type { AssignedWorkGuard } from "../team-authority/assigned-work-guard";
/** Select graph authority after first graph apply; otherwise retain legacy guard. */
export class CompositeAssignedWorkGuard implements AssignedWorkGuard {
  constructor(
    private readonly graph: AssignedWorkGuard & { hasGraph(teamName: string): boolean },
    private readonly legacy: AssignedWorkGuard,
  ) {}

  nonterminalTaskIds(teamName: string): Promise<string[]> {
    return this.graph.hasGraph(teamName)
      ? this.graph.nonterminalTaskIds(teamName)
      : this.legacy.nonterminalTaskIds(teamName);
  }

  nonterminalTaskIdsAssignedToWorker(teamName: string, workerName: string): Promise<string[]> {
    return this.graph.hasGraph(teamName)
      ? this.graph.nonterminalTaskIdsAssignedToWorker(teamName, workerName)
      : this.legacy.nonterminalTaskIdsAssignedToWorker(teamName, workerName);
  }
}
