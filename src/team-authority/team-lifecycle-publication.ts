export type WorkerStartupObservation =
  | { observed: true; carrier: "session_bound"; runtime: "observed"; cursor: string }
  | {
    observed: false;
    carrier: "prepared" | "session_bound";
    runtime: "not_observed";
    cursor: string;
    reason: "timeout" | "authority_mismatch";
  };

/**
 * Coordination publication and bounded startup observation for Team-owned
 * Worker carriers. Team authority chooses transitions; this port records and
 * observes their Coordination evidence.
 */
export interface TeamLifecyclePublication {
  readEventCursor(teamName: string): string;
  recordWorkerPrepared(input: {
    teamName: string;
    workerName: string;
    membershipId: string;
  }): Promise<{ cursor: string }>;
  recordWorkerStopped(input: {
    teamName: string;
    workerName: string;
    membershipId: string;
  }): Promise<{ cursor: string }>;
  recordWorkerSessionBound(input: {
    teamName: string;
    workerName: string;
    membershipId: string;
    generation: { membershipId: string; pid: number; startedAt: number };
  }): Promise<{ cursor: string }>;
  recordWorkerFailed(input: {
    teamName: string;
    workerName: string;
    membershipId: string;
  }): Promise<{ cursor: string }>;
  observeWorkerStartup(input: {
    teamName: string;
    workerName: string;
    membershipId: string;
    afterCursor: string;
    signal?: AbortSignal;
  }): Promise<WorkerStartupObservation>;
}
