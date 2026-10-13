import { hostEnv, type TimerHandle } from "../env/host-env";
import path from "node:path";
import * as teams from "../utils/teams";
import * as runtime from "../utils/runtime";
import { assertLockDeadline, LockDeadlineError, withLock, withLockDeadline } from "../utils/lock";
import { teamDir } from "../utils/paths";
import { deriveCarrierView, herdrList, launchIsStalled, type CarrierView } from "../carrier-observation";
import type { IdentifiedInboxMessage } from "../alert-authority/delivery-contracts";
import type { Member, TeamConfig, TerminalTarget } from "./contracts";
import { removeWorkerAggregate, type QualifiedAvailableModelKeys } from "../utils/worker-resource-projection";
import { resolveWorkerModelRole, type ModelRoleSettings } from "../utils/model-role-settings";
import { normalizeWorkerCarrier, planWorkerEnsure, type WorkerRecoveryMode } from "../utils/worker-ensure-lifecycle";
import { HerdrAdapter } from "../adapters/herdr-adapter";
import { Iterm2Adapter } from "../adapters/iterm2-adapter";
import { memberTerminalTarget, terminalTarget } from "../utils/terminal-target";
import { teamPanePlacement } from "../utils/team-pane-placement";
import { currentTerminalForTeam } from "../utils/team-terminal";
import type { SpawnOptions } from "../utils/terminal-adapter";
import { withSemanticTrace } from "../utils/trace";
import type { TeamLifecyclePublication, WorkerStartupObservation } from "./team-lifecycle-publication";
import type { WorkerLaunchObservationState } from "../utils/receipt-types";

export type PreparedLaunchTarget = { terminalId: string; isWindow: boolean; backend: string };
export type PreparedLaunchReceipt = PreparedLaunchTarget & { initialMessage?: IdentifiedInboxMessage };
export interface WorkerAggregate { path?: string; projectTrusted: boolean; modelRoleSettings?: ModelRoleSettings }
export interface WorkerLaunchBridgeDependencies {
  buildWorkerArgv(model: string | undefined, thinking: Member["thinking"], aggregatePath: string | undefined, projectTrusted: boolean): string[];
  workerAggregate(cwd: string): WorkerAggregate;
  lifecyclePublication: TeamLifecyclePublication;
}
export class WorkerModelConflictError extends Error {
  constructor(readonly workerName: string, readonly currentAlias: string | undefined, readonly requestedAlias: string) {
    super(`Worker ${workerName} already has model role ${currentAlias ?? "<historical selection>"}; refusing to reconfigure it with ${requestedAlias}.`);
  }
}
export class WorkerLegacyTeamModelDefaultError extends Error {
  constructor() { super("This Team has a legacy raw model default. Finish it with its original version or create a new Team with pi_team_bright.default_model_role before creating another Worker."); }
}
export interface WorkerLaunchRequest {
  teamName: string; workerName: string; scope: string; cwd: string; modelRole?: string;
  preserveHistoricalModelSelection?: boolean; thinking?: Member["thinking"]; modelProfile?: Member["modelProfile"];
  availableModelKeys?: QualifiedAvailableModelKeys; signal?: AbortSignal;
  workerAggregate?: (cwd: string) => WorkerAggregate;
  initialMessage?: () => Promise<IdentifiedInboxMessage>;
  launchEnvironment?: Record<string, string>;
}
export type WorkerLaunchResult =
  | { action: "reused"; member: Member; membershipId: string; target?: TerminalTarget; lastStop?: CarrierView["lastStop"] }
  | { action: "attention"; member?: Member; membershipId?: string; paneId?: string; launchId?: string; launch: CarrierView["launch"]; lastStop?: CarrierView["lastStop"]; reason: string; nextActionHint: "wait" | "ask_human" }
  | { action: "created" | "recovered"; member: Member; membershipId: string; recoveryMode?: WorkerRecoveryMode; target?: PreparedLaunchTarget; startup: WorkerStartupObservation; launchId: string; launch: "requested"; lastStop?: CarrierView["lastStop"] };
export function launchObservationState(observation: WorkerStartupObservation): WorkerLaunchObservationState {
  return observation.observed ? { carrier: "session_bound", runtime: "observed" } : { carrier: observation.carrier, runtime: "not_observed" };
}
export type ResolvedWorkerModel = { model?: string; binding?: Member["modelProfile"] };
export function createWorkerLaunchBridge(dependencies: WorkerLaunchBridgeDependencies): WorkerLaunchBridge { return new WorkerLaunchBridge(dependencies); }
type LaunchClaim = { member: Member; config: TeamConfig; action: "created" | "recovered"; recoveryMode?: WorkerRecoveryMode; lastStop?: CarrierView["lastStop"] };

/** A durable launch marker precedes every external effect. No readiness wait owns a lease. */
export class WorkerLaunchBridge {
  constructor(private readonly dependencies: WorkerLaunchBridgeDependencies) {}
  resolveInitialWorkerModel(request: WorkerLaunchRequest, config: TeamConfig, aggregate: WorkerAggregate): ResolvedWorkerModel {
    if (request.preserveHistoricalModelSelection) return {};
    if (request.modelProfile) return { model: `${request.modelProfile.provider}/${request.modelProfile.model}`, binding: request.modelProfile };
    if (config.defaultModel !== undefined) throw new WorkerLegacyTeamModelDefaultError();
    if (!aggregate.modelRoleSettings) throw new Error("Worker model role settings are unavailable.");
    const binding = resolveWorkerModelRole(request.modelRole, aggregate.modelRoleSettings, request.availableModelKeys);
    return { model: `${binding.provider}/${binding.model}`, binding };
  }
  async ensureWorker(request: WorkerLaunchRequest): Promise<WorkerLaunchResult> {
    return withSemanticTrace("worker_launch", { teamName: request.teamName, workerName: request.workerName }, async () => {
      const deadline = hostEnv().clock.now() + 10000;
      const receipt = new AbortController();
      const observed: { member?: Member; paneId?: string } = {};
      const expired = (): WorkerLaunchResult => ({ action: "attention", member: observed.member, membershipId: observed.member?.membershipId,
        paneId: observed.paneId ?? observed.member?.terminalTarget?.targetId, launchId: observed.member?.launch?.launchId,
        launch: "unknown", reason: "receipt_deadline", nextActionHint: "ask_human" });
      // Async scope propagates the receipt deadline through every nested persistence lock.
      const operation = withLockDeadline(deadline, async () => {
        const claim = await withLock(path.join(teamDir(request.teamName), `launch-${encodeURIComponent(request.workerName)}`), () => this.claim(request, member => { observed.member = member; }));
        assertLockDeadline();
        if (!("config" in claim)) return this.inspectAttention(request, claim);
        observed.member = claim.member;
        return this.launch(request, claim, deadline, paneId => { observed.paneId = paneId; });
      }, receipt.signal);
      let timer: TimerHandle | undefined;
      try {
        return await Promise.race([operation, new Promise<WorkerLaunchResult>(resolve => {
          timer = hostEnv().clock.setTimeout(() => { receipt.abort(); resolve(expired()); }, Math.max(0, deadline - hostEnv().clock.now()));
        })]);
      } catch (error) { if (error instanceof LockDeadlineError) return expired(); throw error; }
      finally { hostEnv().clock.clearTimeout(timer); }
    });
  }
  private async inspectAttention(request: WorkerLaunchRequest, result: WorkerLaunchResult): Promise<WorkerLaunchResult> {
    if (result.action !== "attention" || ["legacy_unverified", "generation_helper_missing"].includes(result.reason) || !result.member || result.member.terminalTarget?.backend !== "herdr"
      || !launchIsStalled(result.member, [])) return result;
    const agents = await herdrList("agent").catch(() => undefined);
    assertLockDeadline();
    if (!launchIsStalled(result.member, agents)) return result;
    const observed = result.member;
    return teams.withCurrentMembershipLease(request.teamName, observed.membershipId!, async current => {
      if (current.launch?.launchId !== observed.launch?.launchId || current.sessionFile !== observed.sessionFile
        || current.terminalTarget?.targetId !== observed.terminalTarget?.targetId || !launchIsStalled(current, agents)) return result;
      return { ...result, member: current, paneId: current.terminalTarget?.targetId, reason: "launch_stalled", nextActionHint: "ask_human" };
    });
  }
  private async claim(request: WorkerLaunchRequest, observe: (member: Member) => void): Promise<LaunchClaim | WorkerLaunchResult> {
    const config = await teams.readConfig(request.teamName);
    if (config.separateWindows) {
      const terminal = currentTerminalForTeam(config);
      if (!terminal.supportsWindows()) throw new Error(`Separate windows mode is not supported in ${terminal.name}.`);
    }
    const member = [...config.members].reverse().find(m => m.name === request.workerName && m.agentType === "teammate" && m.isActive !== false);
    if (member) {
      observe(member);
      if (request.modelRole !== undefined && member.modelProfile?.alias !== request.modelRole) throw new WorkerModelConflictError(member.name, member.modelProfile?.alias, request.modelRole);
      return teams.withCurrentMembershipLease(request.teamName, member.membershipId!, async current => {
        const status = await runtime.readRuntimeStatus(request.teamName, member.name);
        assertLockDeadline();
        const view = deriveCarrierView(current, status);
        const plan = planWorkerEnsure(normalizeWorkerCarrier(current), view);
        // Even a bound dead prior generation cannot bypass an in-flight recovery.
        const pending = current.launch && (current.launch.state === "requested" || current.launch.state === "started" || current.launch.state === "unknown")
          && (!status || current.launch.priorGeneration?.osBirthToken === status.osBirthToken);
        if (pending && plan.action !== "reuse" && !(plan.action === "attention" && ["legacy_unverified", "generation_helper_missing"].includes(plan.reason))) return { action: "attention", member: current, membershipId: current.membershipId!, launchId: view.launchId, launch: view.launch, lastStop: view.lastStop, reason: "launch_pending", nextActionHint: "wait" };
        if (plan.action === "reuse") return { action: "reused", member: current, membershipId: current.membershipId!, target: memberTerminalTarget(current, config.terminalBackend), lastStop: view.lastStop };
        if (plan.action === "attention") return { action: "attention", member: current, membershipId: current.membershipId!, launchId: view.launchId, launch: view.launch, lastStop: view.lastStop, reason: plan.reason, nextActionHint: plan.nextActionHint };
        if (plan.action === "refuse") throw new Error(`Invalid carrier: ${plan.reason}`);
        const launchId = teams.newLaunchId();
        const updated = await teams.updateMembership(request.teamName, current.membershipId!, {
          launch: { launchId, state: "requested", requestedAt: hostEnv().clock.now(), ...(status?.pid ? { priorGeneration: { pid: status.pid, osBirthToken: status.osBirthToken, bootId: status.bootId } } : {}) },
          ...(!current.sessionFile ? { pendingLaunchId: launchId } : {}),
        });
        return { member: updated, config, action: plan.action === "recover" ? "recovered" : "created", ...(plan.action === "recover" ? { recoveryMode: plan.recoveryMode } : {}), lastStop: view.lastStop };
      });
    }
    const aggregate = (request.workerAggregate ?? this.dependencies.workerAggregate)(request.cwd);
    let chosen: ResolvedWorkerModel;
    try { chosen = this.resolveInitialWorkerModel(request, config, aggregate); }
    finally { removeWorkerAggregate(aggregate.path); }
    const launchId = teams.newLaunchId();
    const prepared: Member = { membershipId: teams.newMembershipId(), pendingLaunchId: launchId,
      launch: { launchId, state: "requested", requestedAt: hostEnv().clock.now() }, agentId: `${request.workerName}@${request.teamName}`,
      name: request.workerName, agentType: "teammate", model: chosen.model, modelProfile: chosen.binding,
      joinedAt: hostEnv().clock.now(), cwd: request.cwd, subscriptions: [], isActive: true, prompt: request.scope, color: "blue", thinking: chosen.binding?.thinking ?? request.thinking };
    await teams.addMember(request.teamName, prepared);
    observe(prepared);
    assertLockDeadline();
    await this.dependencies.lifecyclePublication.recordWorkerPrepared({ teamName: request.teamName, workerName: prepared.name, membershipId: prepared.membershipId! });
    return { member: prepared, config, action: "created" };
  }
  private async launch(request: WorkerLaunchRequest, claim: LaunchClaim, deadline: number, observePane: (paneId: string) => void): Promise<WorkerLaunchResult> {
    const { member, config } = claim;
    const launchId = member.launch!.launchId;
    const terminal = currentTerminalForTeam(config);
    const aggregate = (request.workerAggregate ?? this.dependencies.workerAggregate)(member.cwd);
    const exactResume = claim.recoveryMode === "exact_session_resume";
    const argv = this.dependencies.buildWorkerArgv(exactResume ? undefined : member.model, exactResume ? undefined : member.modelProfile?.thinking ?? member.thinking, aggregate.path, aggregate.projectTrusted);
    if (exactResume) argv.push("--session", member.sessionFile!);
    const env = { ...hostEnv().process.env, ...request.launchEnvironment, PI_TEAM_NAME: request.teamName, PI_AGENT_NAME: member.name,
      PI_TEAM_MEMBERSHIP_ID: member.membershipId!, PI_AGENT_LAUNCH_ID: launchId, ...(aggregate.path ? { PI_TEAM_BRIGHT_WORKER_AGGREGATE: aggregate.path } : {}) } as Record<string, string>;
    const options: SpawnOptions = { name: member.name, cwd: member.cwd, argv, env, panePlacement: teamPanePlacement(config, terminal.name, member.membershipId) };
    let target: PreparedLaunchTarget | undefined;
    try {
      if (request.initialMessage) await request.initialMessage();
      assertLockDeadline();
      if (terminal instanceof Iterm2Adapter) {
        const last = options.panePlacement?.workerPaneIds.at(-1);
        terminal.setSpawnContext(last?.startsWith("iterm_") ? { lastSessionId: last.replace("iterm_", "") } : {});
      }
      const terminalId = terminal instanceof HerdrAdapter ? await terminal.prepareSpawnAsync(options, deadline)
        : config.separateWindows ? terminal.spawnWindow(options) : terminal.spawn(options);
      target = { terminalId, isWindow: !!config.separateWindows, backend: terminal.name };
      observePane(terminalId);
      assertLockDeadline();
      // This CAS records the target before Herdr starts the process.
      await teams.withCurrentMembershipLease(request.teamName, member.membershipId!, async current => {
        if (current.launch?.launchId !== launchId) throw new Error("Launch target belongs to a superseded launch. Inspect the orphan pane.");
        await teams.updateMembership(request.teamName, member.membershipId!, { terminalTarget: terminalTarget(terminal.name, target!.isWindow ? "window" : "pane", terminalId) });
      });
      assertLockDeadline();
      const completion = terminal instanceof HerdrAdapter ? terminal.startPrepared(terminalId, options) : Promise.resolve({ state: "started" as const, fact: "carrier_start_accepted" });
      void completion.then(result => this.completeLaunch(request.teamName, member.membershipId!, launchId, result))
        .catch(() => this.completeLaunch(request.teamName, member.membershipId!, launchId, { state: "unknown", fact: "completion_unavailable" })).catch(() => undefined);
    } catch (error) {
      // Unknown effect keeps its marker and pane. Time and transport errors never authorize cleanup.
      void this.completeLaunch(request.teamName, member.membershipId!, launchId, { state: "unknown", fact: error instanceof Error ? error.message : String(error) }, target).catch(() => undefined);
      if (error instanceof LockDeadlineError) throw error;
    }
    return { action: claim.action, member, membershipId: member.membershipId!, recoveryMode: claim.recoveryMode, target, launchId, launch: "requested", lastStop: claim.lastStop,
      startup: { observed: false, carrier: member.sessionFile ? "session_bound" : "prepared", runtime: "not_observed", cursor: this.dependencies.lifecyclePublication.readEventCursor(request.teamName), reason: "requested" } };
  }
  async completeLaunch(teamName: string, membershipId: string, launchId: string, result: { state: "started" | "refused" | "unknown"; fact: string }, target?: PreparedLaunchTarget): Promise<boolean> {
    // Receipt expiry may leave a prepared pane. Reconcile only the same launch, never start it.
    return withLockDeadline(hostEnv().clock.now() + 60000, () => teams.withCurrentMembershipLease(teamName, membershipId, async current => {
      if (current.launch?.launchId !== launchId) return false;
      await teams.updateMembership(teamName, membershipId, { launch: { ...current.launch, ...result, observedAt: hostEnv().clock.now() },
        ...(target ? { terminalTarget: terminalTarget(target.backend, target.isWindow ? "window" : "pane", target.terminalId) } : {}) });
      return true;
    }));
  }
  async launchPreparedMembership(teamName: string, prepared: Member, initialMessage: (() => Promise<IdentifiedInboxMessage>) | null, spawn: () => PreparedLaunchTarget | Promise<PreparedLaunchTarget>, _aggregatePath?: string): Promise<PreparedLaunchReceipt> {
    const message = initialMessage ? await initialMessage() : undefined;
    const target = await spawn();
    await teams.updateMembership(teamName, prepared.membershipId!, { terminalTarget: terminalTarget(target.backend, target.isWindow ? "window" : "pane", target.terminalId) });
    return { ...target, ...(message ? { initialMessage: message } : {}) };
  }
  observeLaunchedWorker(teamName: string, workerName: string, membershipId: string, afterCursor: string, signal?: AbortSignal, defaultTimeoutMs?: number): Promise<WorkerStartupObservation> {
    return this.dependencies.lifecyclePublication.observeWorkerStartup({ teamName, workerName, membershipId, afterCursor, signal, defaultTimeoutMs });
  }
}
