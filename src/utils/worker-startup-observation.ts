import type { TeamEventWaitResult } from "./team-events";

export const WORKER_STARTUP_OBSERVATION_MS = 3_000;

export type WorkerStartupObservation =
  | { observed: true; carrier: "session_bound"; runtime: "observed"; cursor: string }
  | {
    observed: false;
    carrier: "prepared" | "session_bound";
    runtime: "not_observed";
    cursor: string;
    reason: "timeout" | "authority_mismatch";
  };

export interface WorkerStartupObservationInput {
  teamName: string;
  workerName: string;
  membershipId: string;
  afterCursor: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Event authority; injected so launch-transition behavior is deterministic in tests. */
  waitForEvents: (input: {
    teamName: string;
    afterCursor: string;
    eventTypes: ["worker"];
    limit: number;
    waitMs: number;
    signal?: AbortSignal;
  }) => Promise<TeamEventWaitResult>;
  /** Verify durable Membership plus exact runtime generation after the binding event. */
  verifyAuthority: () => Promise<{ sessionBound: boolean; runtimeObserved: boolean }>;
  now?: () => number;
}

/**
 * Observe one launch transition through the Team event journal. This is a
 * bounded, event-driven startup acknowledgement, not a Worker progress poll.
 */
export async function observeWorkerStartup(
  input: WorkerStartupObservationInput,
): Promise<WorkerStartupObservation> {
  const timeoutMs = input.timeoutMs ?? WORKER_STARTUP_OBSERVATION_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("Worker startup observation timeout must be a nonnegative finite number.");
  }

  const now = input.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let cursor = input.afterCursor;

  while (true) {
    const remaining = Math.max(0, deadline - now());
    const batch = await input.waitForEvents({
      teamName: input.teamName,
      afterCursor: cursor,
      eventTypes: ["worker"],
      limit: 100,
      waitMs: remaining,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    cursor = batch.cursor;

    const bound = batch.events.some((event) => event.type === "worker"
      && event.worker === input.workerName
      && event.membershipId === input.membershipId
      && event.phase === "session_bound");
    if (bound) {
      const authority = await input.verifyAuthority();
      if (authority.sessionBound && authority.runtimeObserved) {
        return { observed: true, carrier: "session_bound", runtime: "observed", cursor };
      }
      return {
        observed: false,
        carrier: authority.sessionBound ? "session_bound" : "prepared",
        runtime: "not_observed",
        cursor,
        reason: "authority_mismatch",
      };
    }

    if (batch.timedOut || now() >= deadline) {
      const authority = await input.verifyAuthority();
      return {
        observed: false,
        carrier: authority.sessionBound ? "session_bound" : "prepared",
        runtime: "not_observed",
        cursor,
        reason: "timeout",
      };
    }
  }
}
