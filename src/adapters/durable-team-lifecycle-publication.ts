import * as runtime from "../utils/runtime";
import * as teamEvents from "../coordination/event-journal";
import * as teams from "../utils/teams";
import {
  observeWorkerStartup,
  resolveWorkerStartupObservationTimeoutMs,
} from "../utils/worker-startup-observation";
import type {
  TeamLifecyclePublication,
  WorkerStartupObservation,
} from "../team-authority/team-lifecycle-publication";

/** Durable Coordination adapter for Team Worker carrier transitions. */
export class DurableTeamLifecyclePublication implements TeamLifecyclePublication {
  readEventCursor(teamName: string): string {
    return teamEvents.readTeamEventCursor(teamName);
  }

  recordWorkerPrepared(input: { teamName: string; workerName: string; membershipId: string }): Promise<{ cursor: string }> {
    return teamEvents.appendTeamEvent(input.teamName, {
      type: "worker",
      worker: input.workerName,
      membershipId: input.membershipId,
      phase: "prepared",
    });
  }

  recordWorkerStopped(input: { teamName: string; workerName: string; membershipId: string }): Promise<{ cursor: string }> {
    return teamEvents.appendTeamEvent(input.teamName, {
      type: "worker",
      worker: input.workerName,
      membershipId: input.membershipId,
      phase: "stopped",
    });
  }

  recordWorkerSessionBound(input: { teamName: string; workerName: string; membershipId: string; generation: { membershipId: string; pid: number; startedAt: number } }): Promise<{ cursor: string }> {
    return teamEvents.appendTeamEvent(input.teamName, { type: "worker", worker: input.workerName, membershipId: input.membershipId, phase: "session_bound", generation: input.generation });
  }

  recordWorkerFailed(input: { teamName: string; workerName: string; membershipId: string }): Promise<{ cursor: string }> {
    return teamEvents.appendTeamEvent(input.teamName, { type: "worker", worker: input.workerName, membershipId: input.membershipId, phase: "failed" });
  }

  async observeWorkerStartup(input: {
    teamName: string;
    workerName: string;
    membershipId: string;
    afterCursor: string;
    defaultTimeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<WorkerStartupObservation> {
    const timeoutMs = resolveWorkerStartupObservationTimeoutMs(
      process.env.PI_TEAMS_WORKER_STARTUP_WAIT_MS,
      input.defaultTimeoutMs,
    );
    return observeWorkerStartup({
      ...input,
      timeoutMs,
      waitForEvents: (options) => teamEvents.waitForTeamEvents(options),
      verifyAuthority: async () => {
        try {
          const current = await teams.currentMembership(input.teamName, input.workerName);
          const status = await runtime.readRuntimeStatus(input.teamName, input.workerName);
          return {
            sessionBound: current.membershipId === input.membershipId && !!current.sessionFile,
            generation: runtime.runtimeGeneration(status) ?? undefined,
          };
        } catch {
          return { sessionBound: false, runtimeObserved: false };
        }
      },
    });
  }
}
