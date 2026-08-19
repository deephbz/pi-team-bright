import * as teams from "../utils/teams";
import * as runtime from "../utils/runtime";
import type { IdentifiedInboxMessage } from "../alert-authority/delivery-contracts";
import type { Member, TeamConfig, TerminalTarget } from "../team-authority/contracts";
import { removeWorkerAggregate, type QualifiedAvailableModelKeys, type WorkerDefaultModelOverride } from "../utils/worker-resource-projection";
import {
  normalizeWorkerCarrier,
  planWorkerEnsure,
  type WorkerRecoveryMode,
  type WorkerEnsurePlan,
} from "../utils/worker-ensure-lifecycle";
import { getAdapterByName } from "../adapters/terminal-registry";
import { Iterm2Adapter } from "../adapters/iterm2-adapter";
import { memberTerminalTarget, terminalTarget } from "../utils/terminal-target";
import { teamPanePlacement } from "../utils/team-pane-placement";
import { assertTargetSupportedByTerminal, currentTerminalForTeam } from "../utils/team-terminal";
import { recordWorkerLaunchStage, withSemanticTrace } from "../utils/trace";
import type { TeamLifecyclePublication, WorkerStartupObservation } from "./team-lifecycle-publication";
import type { WorkerLaunchObservationState } from "../utils/receipt-types";

export type PreparedLaunchTarget = { terminalId: string; isWindow: boolean; backend: string };
export type PreparedLaunchReceipt = PreparedLaunchTarget & { initialMessage?: IdentifiedInboxMessage };

export interface WorkerAggregate {
  path?: string;
  projectTrusted: boolean;
  defaultModel?: WorkerDefaultModelOverride;
}

export interface WorkerLaunchBridgeDependencies {
  /** Build the normal Pi argv with the already resolved model and aggregate. */
  buildWorkerArgv(model: string | undefined, thinking: Member["thinking"], aggregatePath: string | undefined, projectTrusted: boolean): string[];
  /** Resolve a model name to provider/model form when the caller requests one. */
  resolveModel(modelName: string): string | null;
  /** Confirm that a qualified Worker setting is available without provider selection. */
  resolveSettingsModel(modelName: string, availableModelKeys?: QualifiedAvailableModelKeys): string | null;
  /** Resolve the Worker-process resource projection for one launch. */
  workerAggregate(cwd: string): WorkerAggregate;
  /** Durable Coordination publication and startup observation for Worker carriers. */
  lifecyclePublication: TeamLifecyclePublication;
}

export class WorkerDefaultModelConfigurationError extends Error {
  constructor(readonly scope: WorkerDefaultModelOverride["scope"], reason: string) {
    const location = scope === "project" ? "trusted project Pi settings" : "global Pi settings";
    super(`Worker default_model in ${location} ${reason}. Edit pi_team_bright.worker.default_model, then retry before creating a Worker carrier.`);
    this.name = "WorkerDefaultModelConfigurationError";
  }
}

export interface WorkerLaunchRequest {
  teamName: string;
  workerName: string;
  /** Durable logical Worker scope. It becomes the launch prompt/profile only. */
  scope: string;
  cwd: string;
  model?: string;
  thinking?: Member["thinking"];
  /** Ephemeral qualified keys captured from this exact model-tool invocation. */
  availableModelKeys?: QualifiedAvailableModelKeys;
  signal?: AbortSignal;
  workerAggregate?: (cwd: string) => WorkerAggregate;
  initialMessage?: () => Promise<IdentifiedInboxMessage>;
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
type PreparedCompensationOutcome = "deactivated" | "session_bound";

type WorkerRecoveryInput = {
  teamName: string;
  teamConfig: TeamConfig;
  teamTerminal: ReturnType<typeof currentTerminalForTeam>;
  member: Member;
  argv: string[];
  env: Record<string, string>;
  useSeparateWindow: boolean;
};

type WorkerRecoveryExecution =
  | { action: "reused"; member: Member; target?: TerminalTarget }
  | {
    action: "recovered";
    target: PreparedLaunchTarget;
    recoveryMode: WorkerRecoveryMode;
    priorRuntimeGeneration?: runtime.RuntimeGeneration;
  };

function exactRuntimeGeneration(member: Member, status: runtime.AgentRuntimeStatus | null): runtime.RuntimeGeneration | null {
  const generation = runtime.runtimeGeneration(status);
  return member.membershipId && generation?.membershipId === member.membershipId ? generation : null;
}

function sameRuntimeGeneration(left: runtime.RuntimeGeneration, right: runtime.RuntimeGeneration): boolean {
  return left.membershipId === right.membershipId && left.pid === right.pid && left.startedAt === right.startedAt;
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
    return withSemanticTrace(
      "worker_launch",
      { teamName: request.teamName, workerName: request.workerName },
      () => this.ensureWorkerWithTrace(request),
    );
  }

  private async ensureWorkerWithTrace(request: WorkerLaunchRequest): Promise<WorkerLaunchResult> {
    const { teamName, workerName, scope, cwd, signal } = request;
    recordWorkerLaunchStage("ensure_started");
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
        if (workerPlan.reason === "unbound_live") {
          throw new Error(
            `Current Membership for ${workerName} has a live terminal carrier before exact Session binding. Refusing to reuse unbound capacity; wait for binding or stop the exact carrier.`,
          );
        }
        throw new Error(
          `Current Membership for ${workerName} has invalid carrier evidence: ${workerPlan.reason}.`,
        );
      }

      if (workerPlan.action === "reuse") {
        recordWorkerLaunchStage("carrier_reused", { membershipId: existingMember.membershipId! });
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

      const recovery = workerPlan.carrier;
      if (recovery.kind === "prepared") {
        env.PI_AGENT_LAUNCH_ID = recovery.pendingLaunchId;
      } else {
        delete env.PI_AGENT_LAUNCH_ID;
      }
      env.PI_TEAM_MEMBERSHIP_ID = recovery.membershipId;
      const argv = recovery.kind === "bound"
        ? [...baseArgv, "--session", recovery.sessionFile]
        : baseArgv;
      let recoveryCursor: string;
      try {
        recoveryCursor = this.dependencies.lifecyclePublication.readEventCursor(teamName);
      } catch (error) {
        removeWorkerAggregate(aggregate.path);
        throw error;
      }
      const execution = await this.executeWorkerRecovery({
        teamName,
        teamConfig,
        teamTerminal,
        member: recovery.member,
        argv,
        env,
        useSeparateWindow,
      });
      if (execution.action === "reused") {
        // This ensure resolved a disposable aggregate before the leased
        // revalidation found another ensure's live exact carrier.
        removeWorkerAggregate(aggregate.path);
        return {
          action: "reused",
          member: execution.member,
          membershipId: execution.member.membershipId!,
          ...(execution.target ? { target: execution.target } : {}),
        };
      }
      let startup: WorkerStartupObservation;
      try {
        startup = await this.observeLaunchedWorker(
          teamName,
          workerName,
          recovery.membershipId,
          recoveryCursor,
          signal,
        );
      } catch (error) {
        if (execution.target.backend === "herdr") {
          await this.reconcileHerdrRecoveryCarrier(
            teamName,
            recovery.member,
            execution.target,
            execution.priorRuntimeGeneration,
            aggregate.path,
          );
        }
        throw error;
      }
      recordWorkerLaunchStage(startup.observed ? "session_bound_observed" : "session_bound_not_observed", { membershipId: recovery.membershipId });
      if (!startup.observed && execution.target.backend === "herdr") {
        const outcome = await this.reconcileHerdrRecoveryCarrier(
          teamName,
          recovery.member,
          execution.target,
          execution.priorRuntimeGeneration,
          aggregate.path,
        );
        if (outcome === "stopped") {
          throw new Error(
            `Herdr recovery for ${workerName} did not produce exact Session binding during the bounded observation. `
            + "The exact recovery target was stopped; the Membership remains current for an exact child retry.",
          );
        }
      }
      const current = await teams.currentMembership(teamName, workerName);
      return {
        action: "recovered",
        member: current,
        membershipId: recovery.membershipId,
        recoveryMode: execution.recoveryMode,
        target: execution.target,
        startup,
      };
    }

    const absentPlan: WorkerEnsurePlan = planWorkerEnsure(normalizeWorkerCarrier(undefined), "missing");
    if (absentPlan.action !== "create") throw new Error("Worker ensure planner returned no executable create action.");

    const aggregate = this.resolveWorkerAggregate(request, cwd);
    let chosenModel: string | undefined;
    try {
      chosenModel = this.resolveNewWorkerModel(request, teamConfig, aggregate);
    } catch (error) {
      removeWorkerAggregate(aggregate.path);
      throw error;
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

    let preparedEvent: { cursor: string };
    try {
      await teams.addMember(teamName, member);
      preparedEvent = await this.dependencies.lifecyclePublication.recordWorkerPrepared({
        teamName,
        workerName,
        membershipId: member.membershipId!,
      });
      recordWorkerLaunchStage("membership_prepared", { membershipId: member.membershipId! });
    } catch (error) {
      removeWorkerAggregate(aggregate.path);
      throw error;
    }

    const piCmd = this.dependencies.buildWorkerArgv(chosenModel, request.thinking, aggregate.path, aggregate.projectTrusted);
    const env: Record<string, string> = {
      ...process.env,
      ...request.launchEnvironment,
      PI_TEAM_NAME: teamName,
      PI_AGENT_NAME: workerName,
      PI_TEAM_MEMBERSHIP_ID: member.membershipId!,
      PI_AGENT_LAUNCH_ID: member.pendingLaunchId!,
      ...(aggregate.path ? { PI_TEAM_BRIGHT_WORKER_AGGREGATE: aggregate.path } : {}),
    };

    const launch = await this.launchPreparedMembership(
      teamName,
      member,
      request.initialMessage ?? null,
      () => this.spawnWorkerCarrier(teamConfig, teamTerminal, member, piCmd, env, useSeparateWindow),
      aggregate.path,
    );
    let startup: WorkerStartupObservation;
    try {
      startup = await this.observeLaunchedWorker(
        teamName,
        workerName,
        member.membershipId!,
        preparedEvent.cursor,
        signal,
      );
    } catch (error) {
      if (launch.backend === "herdr") await this.reconcileCancelledHerdrPreparedLaunch(teamName, member, launch, aggregate.path);
      throw error;
    }
    recordWorkerLaunchStage(startup.observed ? "session_bound_observed" : "session_bound_not_observed", { membershipId: member.membershipId! });
    const currentMember = !startup.observed && launch.backend === "herdr"
      ? await this.failUnobservedHerdrPreparedLaunch(teamName, member, launch, aggregate.path)
      : member;
    return {
      action: "created",
      member: currentMember,
      membershipId: member.membershipId!,
      target: launch,
      startup,
    };
  }

  private resolveWorkerAggregate(request: WorkerLaunchRequest, cwd: string): WorkerAggregate {
    return request.workerAggregate?.(cwd) ?? this.dependencies.workerAggregate(cwd);
  }

  private resolveNewWorkerModel(request: WorkerLaunchRequest, teamConfig: TeamConfig, aggregate: WorkerAggregate): string | undefined {
    let model = request.model || teamConfig.defaultModel;
    if (model) {
      if (!model.includes("/")) {
        const resolved = this.dependencies.resolveModel(model);
        if (resolved) {
          model = resolved;
        } else if (teamConfig.defaultModel && teamConfig.defaultModel.includes("/")) {
          const [provider] = teamConfig.defaultModel.split("/");
          model = `${provider}/${model}`;
        }
      }
      return model;
    }

    const configured = aggregate.defaultModel;
    if (!configured) return undefined;
    if (configured.error) throw new WorkerDefaultModelConfigurationError(configured.scope, configured.error);
    const separator = configured.value?.indexOf("/") ?? -1;
    if (separator <= 0 || separator === configured.value!.length - 1 || /\s/.test(configured.value!)) {
      throw new WorkerDefaultModelConfigurationError(configured.scope, "must be a qualified provider/model string");
    }
    const resolved = this.dependencies.resolveSettingsModel(configured.value!, request.availableModelKeys);
    if (!resolved) throw new WorkerDefaultModelConfigurationError(configured.scope, `'${configured.value}' is unavailable from Pi`);
    return resolved;
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
      recordWorkerLaunchStage("carrier_start_accepted", { membershipId: prepared.membershipId! });
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
      recordWorkerLaunchStage("carrier_target_persisted", { membershipId: prepared.membershipId! });
      return { ...target, ...(acceptedMessage ? { initialMessage: acceptedMessage } : {}) };
    } catch (launchError) {
      recordWorkerLaunchStage("compensation_started", { membershipId: prepared.membershipId! });
      if (!target) removeWorkerAggregate(aggregatePath);
      try {
        const outcome = await this.compensatePreparedLaunch(targetTeamName, prepared, target);
        if (outcome === "session_bound") {
          throw new Error(`Prepared Membership for ${prepared.name} completed exact Session binding during compensation.`);
        }
        if (target) removeWorkerAggregate(aggregatePath);
      } catch (cleanupError) {
        recordWorkerLaunchStage("compensation_unconfirmed", { membershipId: prepared.membershipId! });
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

  observeLaunchedWorker(
    teamName: string,
    workerName: string,
    membershipId: string,
    afterCursor: string,
    signal?: AbortSignal,
    defaultTimeoutMs?: number,
  ): Promise<WorkerStartupObservation> {
    return this.dependencies.lifecyclePublication.observeWorkerStartup({
      teamName,
      workerName,
      membershipId,
      afterCursor,
      ...(signal ? { signal } : {}),
      ...(defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs }),
    });
  }

  private async reconcileCancelledHerdrPreparedLaunch(
    teamName: string,
    member: Member,
    target: PreparedLaunchTarget,
    aggregatePath?: string,
  ): Promise<void> {
    recordWorkerLaunchStage("compensation_started", { membershipId: member.membershipId! });
    try {
      const outcome = await this.compensatePreparedLaunch(teamName, member, target);
      if (outcome === "deactivated") removeWorkerAggregate(aggregatePath);
      else recordWorkerLaunchStage("session_binding_won", { membershipId: member.membershipId! });
    } catch (error) {
      recordWorkerLaunchStage("compensation_unconfirmed", { membershipId: member.membershipId! });
      if ((error as { carrierStopConfirmed?: boolean }).carrierStopConfirmed) removeWorkerAggregate(aggregatePath);
      throw new Error(
        `Herdr start for ${member.name} was cancelled during exact Session observation. `
        + `Compensation failed: ${error instanceof Error ? error.message : String(error)}. `
        + "The Membership remains current because process shutdown could not be confirmed.",
      );
    }
  }

  private async failUnobservedHerdrPreparedLaunch(
    teamName: string,
    member: Member,
    target: PreparedLaunchTarget,
    aggregatePath?: string,
  ): Promise<Member> {
    recordWorkerLaunchStage("compensation_started", { membershipId: member.membershipId! });
    try {
      const outcome = await this.compensatePreparedLaunch(teamName, member, target);
      if (outcome === "session_bound") {
        recordWorkerLaunchStage("session_binding_won", { membershipId: member.membershipId! });
        return teams.currentMembership(teamName, member.name);
      }
      removeWorkerAggregate(aggregatePath);
    } catch (error) {
      recordWorkerLaunchStage("compensation_unconfirmed", { membershipId: member.membershipId! });
      if ((error as { carrierStopConfirmed?: boolean }).carrierStopConfirmed) removeWorkerAggregate(aggregatePath);
      throw new Error(
        `Herdr start for ${member.name} did not produce exact Session binding during the bounded observation. `
        + `Compensation failed: ${error instanceof Error ? error.message : String(error)}. `
        + "The Membership remains current because process shutdown could not be confirmed.",
      );
    }
    throw new Error(
      `Herdr start for ${member.name} did not produce exact Session binding during the bounded observation. `
      + "The exact prepared Membership was deactivated after confirmed carrier cleanup.",
    );
  }

  private async reconcileHerdrRecoveryCarrier(
    teamName: string,
    member: Member,
    target: PreparedLaunchTarget,
    priorRuntimeGeneration: runtime.RuntimeGeneration | undefined,
    aggregatePath?: string,
  ): Promise<"authority_won" | "stopped"> {
    const authorityWon = async (current: Member): Promise<boolean> => {
      if (current.membershipId !== member.membershipId) return true;
      const generation = exactRuntimeGeneration(
        current,
        await runtime.readRuntimeStatus(teamName, member.name),
      );
      return !!generation && (!priorRuntimeGeneration || !sameRuntimeGeneration(generation, priorRuntimeGeneration));
    };

    const before = await teams.currentMembership(teamName, member.name);
    if (await authorityWon(before)) {
      recordWorkerLaunchStage("recovery_authority_won", { membershipId: member.membershipId! });
      return "authority_won";
    }

    try {
      const skipped = await teams.withCurrentMembershipLease(teamName, member.membershipId!, async (current) => {
        if (await authorityWon(current)) return true;
        recordWorkerLaunchStage("compensation_started", { membershipId: member.membershipId! });
        stopLaunchTarget(target);
        recordWorkerLaunchStage("carrier_stop_confirmed", { membershipId: member.membershipId! });
        return false;
      });
      if (skipped) {
        recordWorkerLaunchStage("recovery_authority_won", { membershipId: member.membershipId! });
        return "authority_won";
      }
      removeWorkerAggregate(aggregatePath);
      return "stopped";
    } catch (error) {
      const current = await teams.currentMembership(teamName, member.name).catch(() => undefined);
      if (current && await authorityWon(current)) {
        recordWorkerLaunchStage("recovery_authority_won", { membershipId: member.membershipId! });
        return "authority_won";
      }
      recordWorkerLaunchStage("compensation_unconfirmed", { membershipId: member.membershipId! });
      throw new Error(
        `Herdr recovery carrier for ${member.name} could not be reconciled. `
        + `It could not stop ${target.isWindow ? "window" : "pane"} ${target.terminalId}: ${error instanceof Error ? error.message : String(error)}. `
        + "The Membership remains current; reconcile the live process before retrying.",
      );
    }
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
    const panePlacement = teamPanePlacement(teamConfig, teamTerminal.name, member.membershipId);
    if (teamTerminal instanceof Iterm2Adapter) {
      const lastWorkerPaneId = panePlacement.workerPaneIds.at(-1);
      teamTerminal.setSpawnContext(lastWorkerPaneId?.startsWith("iterm_")
        ? { lastSessionId: lastWorkerPaneId.replace("iterm_", "") }
        : {});
    }
    const terminalId = teamTerminal.spawn({ name: member.name, cwd: member.cwd, argv, env, panePlacement });
    return { terminalId, isWindow: false, backend: teamTerminal.name };
  }

  private async compensatePreparedLaunch(targetTeamName: string, prepared: Member, target: PreparedLaunchTarget | null): Promise<PreparedCompensationOutcome> {
    if (!prepared.membershipId) throw new Error(`Prepared Membership for ${prepared.name} has no stable identity.`);
    let carrierStopConfirmed = !target;
    let sessionBound = false;
    try {
      await teams.withCurrentMembershipLease(targetTeamName, prepared.membershipId, async (current) => {
        if (current.sessionFile) {
          sessionBound = true;
          return;
        }
        if (!prepared.pendingLaunchId || current.pendingLaunchId !== prepared.pendingLaunchId) {
          throw new Error(`Prepared Membership for ${prepared.name} no longer has its exact launch capability.`);
        }
        if (target) {
          stopLaunchTarget(target);
          carrierStopConfirmed = true;
          recordWorkerLaunchStage("carrier_stop_confirmed", { membershipId: prepared.membershipId! });
          const status = await runtime.readRuntimeStatus(targetTeamName, prepared.name);
          const generation = exactRuntimeGeneration(prepared, status);
          if (generation) await runtime.deleteRuntimeStatus(targetTeamName, prepared.name, generation);
        }
        await teams.deactivateMembership(targetTeamName, prepared.membershipId!, "replaced");
        recordWorkerLaunchStage("membership_deactivated", { membershipId: prepared.membershipId! });
      });
      return sessionBound ? "session_bound" : "deactivated";
    } catch (error) {
      if (carrierStopConfirmed && error && typeof error === "object") {
        (error as { carrierStopConfirmed?: boolean }).carrierStopConfirmed = true;
      }
      throw error;
    }
  }

  private async executeWorkerRecovery(input: WorkerRecoveryInput): Promise<WorkerRecoveryExecution> {
    const { teamName, teamConfig, teamTerminal, member, argv, env, useSeparateWindow } = input;
    let target: PreparedLaunchTarget | null = null;
    try {
      return await teams.withCurrentMembershipLease(teamName, member.membershipId!, async (leased) => {
        const current = await teams.currentMembership(teamName, member.name);
        if (current.membershipId !== member.membershipId || leased.membershipId !== member.membershipId) {
          throw new Error(`Cannot recover ${member.name}: the exact Membership is no longer current. No candidate was spawned.`);
        }
        const currentTarget = memberTerminalTarget(current, teamConfig.terminalBackend || teamTerminal.name);
        if (currentTarget) assertTargetSupportedByTerminal(teamTerminal, currentTarget);
        const currentObservation = currentTarget?.kind === "window"
          ? (teamTerminal.isWindowAlive(currentTarget.targetId) ? "live" : "missing")
          : currentTarget?.kind === "pane"
            ? (teamTerminal.isAlive(currentTarget.targetId) ? "live" : "missing")
            : "missing";
        const currentPlan = planWorkerEnsure(normalizeWorkerCarrier(current), currentObservation);
        if (currentPlan.action === "reuse") {
          return { action: "reused", member: current, ...(currentTarget ? { target: currentTarget } : {}) };
        }
        if (currentPlan.action !== "recover") {
          if (currentPlan.action === "refuse" && currentPlan.reason === "unbound_live") {
            throw new Error(`Cannot recover ${member.name}: the exact carrier is live but not Session-bound. No candidate was spawned.`);
          }
          throw new Error(`Cannot recover ${member.name}: current carrier evidence is ${currentPlan.action}. No candidate was spawned.`);
        }
        const preflight = runtime.preflightRuntimeRecovery(
          current,
          await runtime.readRuntimeStatus(teamName, member.name),
          runtime.probePidPresence,
          currentPlan.recoveryMode === "first_binding_retry" ? current.pendingLaunchId : undefined,
        );
        if (preflight.kind === "refused") {
          throw new Error(`Cannot recover ${member.name}: ${preflight.reason} No terminal target changed and no candidate was spawned.`);
        }
        target = this.spawnWorkerCarrier(teamConfig, teamTerminal, member, argv, env, useSeparateWindow);
        recordWorkerLaunchStage("carrier_start_accepted", { membershipId: member.membershipId! });
        const update = teamConfig.terminalBackend
          ? { terminalTarget: terminalTarget(target.backend, target.isWindow ? "window" : "pane", target.terminalId) }
          : target.isWindow
            ? { windowId: target.terminalId }
            : { tmuxPaneId: target.terminalId };
        // This records only the exact terminal carrier. The child alone claims
        // runtime and binds its Pi Session after it starts.
        await teams.updateMembership(teamName, member.membershipId!, update);
        recordWorkerLaunchStage("carrier_target_persisted", { membershipId: member.membershipId! });
        return {
          action: "recovered",
          target,
          recoveryMode: currentPlan.recoveryMode,
          ...(preflight.replaces ? { priorRuntimeGeneration: preflight.replaces } : {}),
        };
      });
    } catch (error) {
      // TypeScript does not track assignment inside the leased callback.
      const failedTarget = target as PreparedLaunchTarget | null;
      if (failedTarget) {
        recordWorkerLaunchStage("compensation_started", { membershipId: member.membershipId! });
        try {
          stopLaunchTarget(failedTarget);
          recordWorkerLaunchStage("carrier_stop_confirmed", { membershipId: member.membershipId! });
        } catch (cleanupError) {
          recordWorkerLaunchStage("compensation_unconfirmed", { membershipId: member.membershipId! });
          throw new Error(
            `Failed to recover ${member.name}: ${error instanceof Error ? error.message : String(error)}. `
            + `Compensation could not stop ${failedTarget.isWindow ? "window" : "pane"} ${failedTarget.terminalId}: `
            + `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. `
            + "The Membership remains current; reconcile the live process before retrying.",
          );
        }
      }
      removeWorkerAggregate(env.PI_TEAM_BRIGHT_WORKER_AGGREGATE);
      throw new Error(
        `Failed to recover ${member.name}: ${error instanceof Error ? error.message : String(error)}. `
        + (failedTarget
          ? "The exact recovery target was stopped; the Membership remains current for an exact child retry."
          : "The Membership remains current for exact child startup admission."),
      );
    }
  }
}

export function createWorkerLaunchBridge(dependencies: WorkerLaunchBridgeDependencies): WorkerLaunchBridge {
  return new WorkerLaunchBridge(dependencies);
}