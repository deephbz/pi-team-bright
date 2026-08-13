import type { GraphVersionRef } from "./graph-control";
import type { TaskVersionRef } from "./task-version-ref";

/** One exact Task projection coordinate in a complete graph revision. */
export interface GraphTaskCoordinate {
  taskId: string;
  taskVersion: TaskVersionRef;
}

/** Current complete-graph coordinate presented to non-authority consumers. */
export interface GraphRevisionRetirementInput {
  teamName: string;
  graphVersion: GraphVersionRef;
  graphSequence: number;
  authoritySequence: number;
  operationId: string;
  currentTasks: readonly GraphTaskCoordinate[];
  retiredTasks: readonly GraphTaskCoordinate[];
}

/**
 * Consumer-owned post-commit boundary for complete graph replacement.
 *
 * Task authority commits first. This port then fences superseded exact Task
 * projections and retires derived delivery obligations. The operation is
 * idempotent so an exact graph replay can repair a crash after the authority
 * commit.
 */
export interface GraphRevisionRetirementPort {
  retireGraphRevision(input: GraphRevisionRetirementInput): Promise<void>;
}
