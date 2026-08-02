import * as teams from "./teams";
import * as runtime from "./runtime";
import * as teamEvents from "./team-events";
import type { IdentifiedInboxMessage } from "./models";
import type { Member, TeamConfig, TerminalTarget } from "./models";
import { removeWorkerAggregate } from "./worker-resource-projection";
import {
  normalizeWorkerCarrier,
  planWorkerEnsure,
  type WorkerRecoveryMode,
  type WorkerEnsurePlan,
} from "./worker-ensure-lifecycle";
import { getAdapterByName } from "../adapters/terminal-registry";
import { Iterm2Adapter } from "../adapters/iterm2-adapter";
import { memberTerminalTarget, terminalTarget } from "./terminal-target";
import { assertTargetSupportedByTerminal, currentTerminalForTeam } from "./team-terminal";
import { observeWorkerStartup, WORKER_STARTUP_OBSERVATION_MS, type WorkerStartupObservation } from "./worker-startup-observation";
import type { WorkerLaunchObservationState } from "./tool-results";

export type PreparedLaunchTarget = { terminalId: string; isWindow: boolean; backend: string };
export type PreparedLaunchReceipt = PreparedLaunchTarget & { initialMessage?: IdentifiedInboxMessage };

export interface WorkerAggregate {
  path?: string;
  projectTrusted: boolean;
}

export interface WorkerLaunchBridgeDependencies {
  /** Build the normal Pi argv with the already resolved model and aggregate. */
  buildWorkerArgv(model: string | undefined, thinking: Member["thinking"], aggregatePath: string | undefined, projectTrusted: boolean): string[];
  /** Resolve a model name to provider/model form when the caller requests one. */
  resolveModel(modelName: string): string | null;
  /** Resolve the Worker-process resource projection for one launch. */
  workerAggregate(cwd: string): WorkerAggregate;
}

export interface WorkerLaunchRequest {
  teamName: string;
  workerName: string;
  /** Durable logical Worker scope. It becomes the launch prompt/profile only. */
  scope: string;
  cwd: string;
  model?: string;
  thinking?: Member["thinking"];
  signal?: AbortSignal;
  workerAggregate?: (cwd: string) => WorkerAggregate;
  launchEnvironment?: Record<string, string>;
}

export type WorkerLaunchResult =
  | {
    action: "reused";
    member: Member;
    membershipId: string;
    target?: TerminalTarget;
  }
  | {
    action: "recovered";
    member: Member;
    membershipId: string;
    recoveryMode: WorkerRecoveryMode;
    target: PreparedLaunchTarget;
    startup: WorkerStartupObservation;
  }
  | {
    action: "created";
    member: Member;
    membershipId: string;
    target: PreparedLaunchTarget;
    startup: WorkerStartupObservation;
  };

type PreparedLaunchSpawn = () => PreparedLaunchTarget | Promise<PreparedLaunchTarget>;

type WorkerRecoveryInput = {
  teamName: string;
  teamConfig: TeamConfig;
  teamTerminal: ReturnType<typeof currentTerminalForTeam>;
  member: Member;
  mode: WorkerRecoveryMode;
  argv: string[];
  env: Record<string, string>;
  useSeparateWindow: boolean;
};

function exactRuntimeGeneration(member: Member, status: runtime.AgentRuntimeStatus | null): runtime.RuntimeGeneration | null {
  const generation = runtime.runtimeGeneration(status);
  return member.membershipId && generation?.membershipId === member.membershipId ? generation : null;
}

function stopLaunchTarget(target: PreparedLaunchTarget): void {
  const launchTerminal = getAdapterByName(target.backend);
  if (!launchTerminal) throw new Error(`cannot stop ${target.terminalId}: terminal backend ${target.backend} is unavailable`);
  if (target.isWindow && !launchTerminal.supportsWindows()) {
    throw new Error(`${launchTerminal.name} doesn't support window targets`);
  }
  if (target.isWindow) {
    launchTerminal.killWindow(target.terminalId);
    if (launchTerminal.isWindowAlive(target.terminalId)) {
      throw new Error(`${launchTerminal.name} did not stop window ${target.terminalId}`);
    }
    return;
  }
  launchTerminal.kill(target.terminalId);
  if (launchTerminal.isAlive(target.terminalId)) {
    throw new Error(`${launchTerminal.name} did not stop pane ${target.terminalId}`);
  }
}

export function launchObservationState(observation: WorkerStartupObservation): WorkerLaunchObservationState {
  return observation.observed
    ? { carrier: "session_bound", runtime: "observed" }
    : { carrier: observation.carrier, runtime: "not_observed" };
}

export class WorkerLaunchBridge {
  constructor(private readonly dependencies: WorkerLaunchBridgeDependencies) {}

  async ensureWorker(request: WorkerLaunchRequest): Promise<WorkerLaunchResult> {
    const { teamName, workerName, scope, cwd, signal } = request;
    if (!teams.teamExists(teamName)) throw new Error(`Team ${teamName} does not exist`);

    const teamConfig = await teams.readConfig(teamName);
    const teamTerminal = currentTerminalForTeam(teamConfig);
    const existingMember = [...teamConfig.members].reverse().find((member) =>
      member.name === workerName && member.agentType === "teammate" && member.isActive !== false);

    if (existingMember) {
      const existingTarget = memberTerminalTarget(existingMember, teamConfig.terminalBackend || teamTerminal.name);
      if (existingTarget) assertTargetSupportedByTerminal(teamTerminal, existingTarget);
      const carrierObservation = existingTarget?.kind === "window"
        ? (teamTerminal.isWindowAlive(existingTarget.targetId) ? "live" : "missing")
        : existingTarget?.kind === "pane"
          ? (teamTerminal.isAlive(existingTarget.targetId) ? "live" : "missing")
          : "missing";
      const workerPlan: WorkerEnsurePlan = planWorkerEnsure(
        normalizeWorkerCarrier(existingMember),
        carrierObservation,
      );

      if (workerPlan.action === "refuse") {
        throw new Error(
          `Current Membership for ${workerName} has invalid carrier evidence: ${workerPlan.carrier.reason}.`,
        );
      }

      if (workerPlan.action === "reuse") {
        return {
          action: "reused",
          member: { ...existingMember },
          membershipId: existingMember.membershipId!,
          ...(existingTarget ? { target: existingTarget } : {}),
        };
      }

      if (workerPlan.action !== "recover") {
        throw new Error("Worker ensure planner returned no executable recovery action.");
      }

      const useSeparateWindow = teamConfig.separateWindows ?? false;
      if (useSeparateWindow && !teamTerminal.supportsWindows()) {
        throw new Error(`Separate windows mode is not supported in ${teamTerminal.name}.`);
      }
      const aggregate = this.resolveWorkerAggregate(request, existingMember.cwd);
      const model = existingMember.model;
      const baseArgv = this.dependencies.buildWorkerArgv(model, existingMember.thinking, aggregate.path, aggregate.projectTrusted);
      const env: Record<string, string> = {
        ...process.env,
        ...request.launchEnvironment,
        PI_TEAM_NAME: teamName,
        PI_AGENT_NAME: workerName,
        ...(aggregate.path ? { PI_TEAM_BRIGHT_WORKER_AGGREGATE: aggregate.path } : {}),
      };

      if (workerPlan.recoveryMode === "first_binding_retry") {
        const prepared = workerPlan.carrier;
        env.PI_AGENT_LAUNCH_ID = prepared.pendingLaunchId;
        let recoveryCursor: string;
        try {
          recoveryCursor = teamEvents.readTeamEventCursor(teamName);
        } catch (error) {
          removeWorkerAggregate(aggregate.path);
          throw error;
        }
        const target = await this.executeWorkerRecovery({
          teamName,
          teamConfig,
          teamTerminal,
          member: prepared.member,
          mode: workerPlan.recoveryMode,
          argv: baseArgv,
          env,
          useSeparateWindow,
        });
        const startup = await this.observeLaunchedWorker(teamName, workerName, existingMember.membershipId!, recoveryCursor, signal);
        const current = await teams.currentMembership(teamName, workerName);
        return {
          action: "recovered",
          member: current,
          membershipId: existingMember.membershipId!,
          recoveryMode: workerPlan.recoveryMode,
          target,
          startup,
        };
      }

      const bound = workerPlan.carrier;
      const resumeArgv = [...baseArgv, "--session", bound.sessionFile];
      delete env.PI_AGENT_LAUNCH_ID;
      let runtimeAdmission: runtime.RuntimeStartupAdmission;
      try {
        runtimeAdmission = await teams.withMembershipMutationLease(teamName, bound.membershipId, async () => {
          const current = await teams.currentMembership(teamName, workerName);
          return runtime.admitRuntimeStartup(
            current,
            bound.sessionFile,
            await runtime.readRuntimeStatus(teamName, workerName),
            -1,
          );
        });
      } catch (error) {
        removeWorkerAggregate(aggregate.path);
        throw error;
      }
      if (runtimeAdmission.kind === "refused") {
        removeWorkerAggregate(aggregate.path);
        throw new Error(`Cannot resume ${workerName}: ${runtimeAdmission.reason} No terminal target changed and no candidate was spawned.`);
      }
      let recoveryCursor: string;
      try {
        recoveryCursor = teamEvents.readTeamEventCursor(teamName);
      } catch (error) {
        removeWorkerAggregate(aggregate.path);
        throw error;
      }
      const target = await this.executeWorkerRecovery({
        teamName,
        teamConfig,
        teamTerminal,
        member: bound.member,
        mode: workerPlan.recoveryMode,
        argv: resumeArgv,
        env,
        useSeparateWindow,
      });
      const startup = await this.observeLaunchedWorker(teamName, workerName, existingMember.membershipId!, recoveryCursor, signal);
      return {
        action: "recovered",
        member: { ...existingMember },
        membershipId: existingMember.membershipId!,
        recoveryMode: workerPlan.recoveryMode,
        target,
        startup,
      };
    }

    const absentPlan: WorkerEnsurePlan = planWorkerEnsure(normalizeWorkerCarrier(undefined), "missing");
    if (absentPlan.action !== "create") throw new Error("Worker ensure planner returned no executable create action.");

    let chosenModel = request.model || teamConfig.defaultModel;
    if (chosenModel && !chosenModel.includes("/")) {
      const resolved = this.dependencies.resolveModel(chosenModel);
      if (resolved) {
        chosenModel = resolved;
      } else if (teamConfig.defaultModel && teamConfig.defaultModel.includes("/")) {
        const [provider] = teamConfig.defaultModel.split("/");
        chosenModel = `${provider}/${chosenModel}`;
      }
    }

    const useSeparateWindow = teamConfig.separateWindows ?? false;
    if (useSeparateWindow && !teamTerminal.supportsWindows()) {
      throw new Error(`Separate windows mode is not supported in ${teamTerminal.name}.`);
    }

    const member: Member = {
      membershipId: teams.newMembershipId(),
      pendingLaunchId: teams.newLaunchId(),
      agentId: `${workerName}@${teamName}`,
      name: workerName,
      agentType: "teammate",
      model: chosenModel,
      joinedAt: Date.now(),
      cwd,
      subscriptions: [],
      isActive: true,
      prompt: scope,
      color: "blue",
      thinking: request.thinking,
    };

    await teams.addMember(teamName, member);
    const preparedEvent = await teamEvents.appendTeamEvent(teamName, {
      type: "worker", worker: workerName, membershipId: member.membershipId!, phase: "prepared",
    });

    const aggregate = this.resolveWorkerAggregate(request, cwd);
    const piCmd = this.dependencies.buildWorkerArgv(chosenModel, request.thinking, aggregate.path, aggregate.projectTrusted);
    const env: Record<string, string> = {
      ...process.env,
      ...request.launchEnvironment,
      PI_TEAM_NAME: teamName,
      PI_AGENT_NAME: workerName,
      PI_AGENT_LAUNCH_ID: member.pendingLaunchId!,
      ...(aggregate.path ? { PI_TEAM_BRIGHT_WORKER_AGGREGATE: aggregate.path } : {}),
    };

    const launch = await this.launchPreparedMembership(
      teamName,
      member,
      null,
      () => this.spawnWorkerCarrier(teamConfig, teamTerminal, member, piCmd, env, useSeparateWindow),
      aggregate.path,
    );
    const startup = await this.observeLaunchedWorker(teamName, workerName, member.membershipId!, preparedEvent.cursor, signal);
    return {
      action: "created",
      member,
      membershipId: member.membershipId!,
      target: launch,
      startup,
    };
  }

  private resolveWorkerAggregate(request: WorkerLaunchRequest, cwd: string): WorkerAggregate {
    return request.workerAggregate?.(cwd) ?? this.dependencies.workerAggregate(cwd);
  }

  async launchPreparedMembership(
    targetTeamName: string,
    prepared: Member,
    initialMessage: (() => Promise<IdentifiedInboxMessage>) | null,
    spawn: PreparedLaunchSpawn,
    aggregatePath?: string,
  ): Promise<PreparedLaunchReceipt> {
    let target: PreparedLaunchTarget | null = null;
    try {
      const acceptedMessage = initialMessage ? await initialMessage() : undefined;
      target = await spawn();
      if (!target.terminalId) throw new Error("terminal adapter returned an empty target ID");
      const teamConfig = await teams.readConfig(targetTeamName);
      await teams.updateMembership(
        targetTeamName,
        prepared.membershipId!,
        teamConfig.terminalBackend
          ? { terminalTarget: terminalTarget(target.backend, target.isWindow ? "window" : "pane", target.terminalId) }
          : target.isWindow
            ? { windowId: target.terminalId }
            : { tmuxPaneId: target.terminalId },
      );
      return { ...target, ...(acceptedMessage ? { initialMessage: acceptedMessage } : {}) };
    } catch (launchError) {
      if (!target) removeWorkerAggregate(aggregatePath);
      try {
        await this.compensatePreparedLaunch(targetTeamName, prepared, target);
        if (target) removeWorkerAggregate(aggregatePath);
      } catch (cleanupError) {
        if ((cleanupError as { carrierStopConfirmed?: boolean }).carrierStopConfirmed) {
          removeWorkerAggregate(aggregatePath);
        }
        const targetText = target
          ? `${target.isWindow ? "window" : "pane"} ${target.terminalId}`
          : "the prepared Membership before terminal spawn";
        throw new Error(
          `Failed to launch ${prepared.name}: ${launchError instanceof Error ? launchError.message : String(launchError)}. `
          + `Compensation failed for ${targetText}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. `
          + "The Membership remains current because process shutdown could not be confirmed.",
        );
      }
      throw new Error(
        `Failed to launch ${prepared.name}: ${launchError instanceof Error ? launchError.message : String(launchError)}. `
        + "The exact prepared Membership was deactivated after compensation.",
      );
    }
  }

  async observeLaunchedWorker(
    targetTeamName: string,
    workerName: string,
    membershipId: string,
    afterCursor: string,
    signal?: AbortSignal,
  ): Promise<WorkerStartupObservation> {
    const configuredWait = process.env.PI_TEAMS_WORKER_STARTUP_WAIT_MS;
    const timeoutMs = configuredWait === undefined ? WORKER_STARTUP_OBSERVATION_MS : Number(configuredWait);
    return observeWorkerStartup({
      teamName: targetTeamName,
      workerName,
      membershipId,
      afterCursor,
      timeoutMs,
      ...(signal ? { signal } : {}),
      waitForEvents: (options) => teamEvents.waitForTeamEvents(options),
      verifyAuthority: async () => {
        try {
          const current = await teams.currentMembership(targetTeamName, workerName);
          const status = await runtime.readRuntimeStatus(targetTeamName, workerName);
          return {
            sessionBound: current.membershipId === membershipId && !!current.sessionFile,
            generation: runtime.runtimeGeneration(status) ?? undefined,
          };
        } catch {
          return { sessionBound: false, runtimeObserved: false };
        }
      },
    });
  }

  private spawnWorkerCarrier(
    teamConfig: TeamConfig,
    teamTerminal: ReturnType<typeof currentTerminalForTeam>,
    member: Member,
    argv: string[],
    env: Record<string, string>,
    useSeparateWindow: boolean,
  ): PreparedLaunchTarget {
    if (useSeparateWindow) {
      const terminalId = teamTerminal.spawnWindow({ name: member.name, cwd: member.cwd, argv, env, teamName: teamConfig.name });
      return { terminalId, isWindow: true, backend: teamTerminal.name };
    }
    if (teamTerminal instanceof Iterm2Adapter) {
      const teammates = teamConfig.members.filter((candidate) => candidate.agentType === "teammate" && candidate.tmuxPaneId?.startsWith("iterm_"));
      const lastTeammate = teammates.length > 0 ? teammates[teammates.length - 1] : null;
      teamTerminal.setSpawnContext(lastTeammate?.tmuxPaneId ? { lastSessionId: lastTeammate.tmuxPaneId.replace("iterm_", "") } : {});
    }
    const leadMember = teamConfig.members.find((candidate) => candidate.name === "team-lead");
    const leadTarget = leadMember ? memberTerminalTarget(leadMember, teamConfig.terminalBackend || teamTerminal.name) : undefined;
    const anchorPaneId = leadTarget?.kind === "pane" ? leadTarget.targetId : teamTerminal.currentTargetId?.() || undefined;
    const terminalId = teamTerminal.spawn({ name: member.name, cwd: member.cwd, argv, env, anchorPaneId });
    return { terminalId, isWindow: false, backend: teamTerminal.name };
  }

  private async compensatePreparedLaunch(targetTeamName: string, prepared: Member, target: PreparedLaunchTarget | null): Promise<void> {
    if (!prepared.membershipId) throw new Error(`Prepared Membership for ${prepared.name} has no stable identity.`);
    let carrierStopConfirmed = !target;
    try {
      await teams.withCurrentMembershipLease(targetTeamName, prepared.membershipId, async () => {
        if (target) {
          stopLaunchTarget(target);
          carrierStopConfirmed = true;
          const status = await runtime.readRuntimeStatus(targetTeamName, prepared.name);
          const generation = exactRuntimeGeneration(prepared, status);
          if (generation) await runtime.deleteRuntimeStatus(targetTeamName, prepared.name, generation);
        }
        await teams.deactivateMembership(targetTeamName, prepared.membershipId!, "replaced");
      });
    } catch (error) {
      if (carrierStopConfirmed && error && typeof error === "object") {
        (error as { carrierStopConfirmed?: boolean }).carrierStopConfirmed = true;
      }
      throw error;
    }
  }

  private async executeWorkerRecovery(input: WorkerRecoveryInput): Promise<PreparedLaunchTarget> {
    const { teamName, teamConfig, teamTerminal, member, mode, argv, env, useSeparateWindow } = input;
    let recoveredTarget: PreparedLaunchTarget | null = null;
    const action = mode === "first_binding_retry" ? "relaunch prepared Worker" : "recover";
    const retained = mode === "first_binding_retry"
      ? "The unconsumed Membership remains current for another exact retry."
      : "The existing Membership and exact Session binding remain current.";
    try {
      recoveredTarget = this.spawnWorkerCarrier(teamConfig, teamTerminal, member, argv, env, useSeparateWindow);
      const update = teamConfig.terminalBackend
        ? { terminalTarget: terminalTarget(recoveredTarget.backend, recoveredTarget.isWindow ? "window" : "pane", recoveredTarget.terminalId) }
        : recoveredTarget.isWindow
          ? { windowId: recoveredTarget.terminalId }
          : { tmuxPaneId: recoveredTarget.terminalId };
      await teams.withCurrentMembershipLease(teamName, member.membershipId!, async () => {
        const current = await teams.currentMembership(teamName, member.name);
        const admission = runtime.admitRuntimeStartup(
          current,
          member.sessionFile || "",
          await runtime.readRuntimeStatus(teamName, member.name),
          -1,
          runtime.probePidPresence,
          member.pendingLaunchId,
        );
        if (admission.kind === "refused") throw new Error(admission.reason);
        if (mode === "first_binding_retry") {
          await teams.updateMembership(teamName, member.membershipId!, update);
        } else {
          await teams.bindMemberSession(teamName, member.name, member.sessionFile!, undefined, update, member.membershipId);
        }
      });
      return recoveredTarget;
    } catch (error) {
      if (recoveredTarget) {
        try {
          stopLaunchTarget(recoveredTarget);
          removeWorkerAggregate(env.PI_TEAM_BRIGHT_WORKER_AGGREGATE);
        } catch (cleanupError) {
          throw new Error(
            `Failed to ${action} ${member.name}: ${error instanceof Error ? error.message : String(error)}. `
            + `Compensation couldn't stop ${recoveredTarget.isWindow ? "window" : "pane"} ${recoveredTarget.terminalId}: `
            + `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. `
            + "The Membership remains current; reconcile the live process before retrying.",
          );
        }
      } else {
        removeWorkerAggregate(env.PI_TEAM_BRIGHT_WORKER_AGGREGATE);
      }
      throw new Error(
        `Failed to ${action} ${member.name}: ${error instanceof Error ? error.message : String(error)}. ${retained}`,
      );
    }
  }
}

export function createWorkerLaunchBridge(dependencies: WorkerLaunchBridgeDependencies): WorkerLaunchBridge {
  return new WorkerLaunchBridge(dependencies);
}