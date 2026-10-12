import { hostEnv } from "../env/host-env";
import type { TeamEventWaitResult } from "../coordination/event-journal";
import type { WorkerRuntimeGenerationEvidence, WorkerTeamEvent } from "../coordination/contracts";

/** Hang ceiling, not a contention-latency failure detector. */
export const WORKER_STARTUP_OBSERVATION_MS = 300_000;
const CARRIER_CHECK_INTERVAL_MS = 250;

export function resolveWorkerStartupObservationTimeoutMs(
  configuredWait?: string,
  defaultTimeoutMs = WORKER_STARTUP_OBSERVATION_MS,
): number {
  const timeoutMs = configuredWait === undefined ? defaultTimeoutMs : Number(configuredWait);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("Worker startup observation timeout must be a nonnegative finite number.");
  }
  return timeoutMs;
}

export type WorkerStartupObservation =
  | { observed: true; carrier: "session_bound"; runtime: "observed"; cursor: string }
  | {
    observed: false;
    carrier: "prepared" | "session_bound";
    runtime: "not_observed";
    cursor: string;
    reason: "timeout" | "authority_mismatch" | "carrier_gone" | "worker_failed";
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
  verifyAuthority: () => Promise<{ sessionBound: boolean; generation?: WorkerRuntimeGenerationEvidence }>;
  /** Terminal-adapter evidence only. Undefined means the probe cannot decide. */
  isCarrierAlive?: () => boolean | undefined | Promise<boolean | undefined>;
  now?: () => number;
  /** Cancellable bounded authority-visibility cadence; injected for deterministic tests. */
  waitForRetry?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
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

  const now = input.now ?? (() => hostEnv().clock.now());
  const waitForRetry = input.waitForRetry ?? ((delayMs: number, signal?: AbortSignal) => hostEnv().clock.sleep(delayMs, signal));
  const deadline = now() + timeoutMs;
  let cursor = input.afterCursor;

  while (true) {
    if (input.isCarrierAlive && await input.isCarrierAlive() === false) {
      return { observed: false, carrier: "prepared", runtime: "not_observed", cursor, reason: "carrier_gone" };
    }
    const remaining = Math.max(0, deadline - now());
    const batch = await input.waitForEvents({
      teamName: input.teamName,
      afterCursor: cursor,
      eventTypes: ["worker"],
      limit: 100,
      waitMs: input.isCarrierAlive ? Math.min(remaining, CARRIER_CHECK_INTERVAL_MS) : remaining,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    cursor = batch.cursor;

    const failed = batch.events.some(event => event.type === "worker"
      && event.worker === input.workerName && event.membershipId === input.membershipId
      && event.phase === "failed");
    if (failed) return { observed: false, carrier: "prepared", runtime: "not_observed", cursor, reason: "worker_failed" };

    const bound = batch.events.find((event): event is WorkerTeamEvent => event.type === "worker"
      && event.worker === input.workerName
      && event.membershipId === input.membershipId
      && event.phase === "session_bound"
      && !!event.generation);
    if (bound?.generation) {
      const expected = bound.generation;
      while (true) {
        const authority = await input.verifyAuthority();
        const generation = authority.generation;
        const exact = authority.sessionBound && generation?.membershipId === expected.membershipId
          && generation?.pid === expected.pid && generation?.startedAt === expected.startedAt;
        if (exact) return { observed: true, carrier: "session_bound", runtime: "observed", cursor };
        if (input.isCarrierAlive && await input.isCarrierAlive() === false) {
          return { observed: false, carrier: authority.sessionBound ? "session_bound" : "prepared", runtime: "not_observed", cursor, reason: "carrier_gone" };
        }
        if (now() >= deadline) return { observed: false, carrier: authority.sessionBound ? "session_bound" : "prepared", runtime: "not_observed", cursor, reason: "timeout" };
        await waitForRetry(Math.min(50, Math.max(0, deadline - now())), input.signal);
      }
    }

    if ((!input.isCarrierAlive && batch.timedOut) || now() >= deadline) {
      const authority = await input.verifyAuthority();
      return { observed: false, carrier: authority.sessionBound ? "session_bound" : "prepared", runtime: "not_observed", cursor, reason: "timeout" };
    }
  }
}
