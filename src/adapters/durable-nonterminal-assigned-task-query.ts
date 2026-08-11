import type { TaskAuthorityWorkerAssignmentReadPort } from "../task-authority/contracts";
import type { NonterminalAssignedTaskQuery } from "../team-authority/assigned-work-guard";

/** Adapts the established Task read seam to the Team lifecycle's exact-Worker guard. */
export class DurableNonterminalAssignedTaskQuery implements NonterminalAssignedTaskQuery {
  constructor(private readonly read: TaskAuthorityWorkerAssignmentReadPort) {}

  nonterminalTaskIdsAssignedToWorker(teamName: string, workerName: string): Promise<string[]> {
    return this.read.listNonterminalTaskIdsAssignedToWorker(teamName, workerName);
  }
}
