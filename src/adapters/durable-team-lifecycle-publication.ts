import { publishPredecessorExit } from "../carrier-observation";
import { hostEnv } from "../env/host-env";
import * as runtime from "../utils/runtime";
import * as teamEvents from "../coordination/event-journal";
import * as teams from "../utils/teams";
import { terminalForTeam } from "../utils/team-terminal";
import { memberTerminalTarget } from "../utils/terminal-target";
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

  recordWorkerGenerationExit(input: Parameters<TeamLifecyclePublication["recordWorkerGenerationExit"]>[0]): Promise<void> {
    return publishPredecessorExit(input.teamName, input.member, input.status, input.terminalBackend);
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
      hostEnv().process.env.PI_TEAMS_WORKER_STARTUP_WAIT_MS,
      input.defaultTimeoutMs,
    );
    return observeWorkerStartup({
      ...input,
      timeoutMs,
      waitForEvents: (options) => teamEvents.waitForTeamEvents(options),
      isCarrierAlive: async () => {
        try {
          const config = await teams.readConfig(input.teamName);
          const current = await teams.currentMembership(input.teamName, input.workerName);
          // Never inspect a replacement carrier for this launch.
          if (current.membershipId !== input.membershipId) return false;
          const adapter = await terminalForTeam(config);
          const target = memberTerminalTarget(current, adapter.name);
          if (!target) return undefined;
          return target.kind === "window" ? await adapter.isWindowAlive(target.targetId)
            : await adapter.isAlive(target.targetId);
        } catch {
          // Read errors and CLI failures cannot prove carrier absence.
          return undefined;
        }
      },
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
