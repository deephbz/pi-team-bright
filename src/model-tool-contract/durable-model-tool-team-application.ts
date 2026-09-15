import { getTerminalAdapter } from "../adapters/terminal-registry";
import * as paths from "../utils/paths";
import * as teams from "../utils/teams";
import type { TaskAuthorityProvisioningPort } from "../task-authority/contracts";
import { loadWorkerResourcePolicy, resolveWorkerLaunchResources, type WorkerModelProfiles } from "../utils/worker-resource-projection";
import { loadTeamPaneLayoutSettings, resolveTeamPaneLayout, type TeamPaneLayout } from "../utils/team-pane-layout";
import type { WorkerLaunchBridge } from "../team-authority/worker-launch-bridge";
import { MODEL_TOOL_WORKER_MARKER } from "./model-tool-constants";
import { loadSyncLivenessSettings } from "../utils/sync-liveness-settings";
import type { Member, TeamConfig } from "../team-authority/contracts";
import type { ModelToolTeamApplicationPort } from "./model-tool-journey-port";
import type { CreateTeamPortResult, EnsureWorkerExecutionContext, EnsureWorkerPortResult, ExactLeaderSessionId, ModelToolTeamCurrent, ModelToolWorkerCurrent, TeamShutdownPortResult, WorkerStopPortResult } from "./model-tool-contracts";
import { WorkerModelProfileConfigurationError } from "../utils/worker-resource-projection";
import { WorkerModelConflictError } from "../team-authority/worker-launch-bridge";
import { DurableModelToolBindings } from "./durable-model-tool-bindings";
export interface ModelToolLifecycle { teamCreated?(teamName: string, sessionFile: string): Promise<void>; stopWorker(teamName: string, worker: string): Promise<WorkerStopPortResult>; shutdownTeam(teamName: string): Promise<TeamShutdownPortResult>; }
function currentTeam(config: TeamConfig): ModelToolTeamCurrent { return { name: config.name, purpose: config.description, lifecycle: "active" }; }
function workerCarrier(member: Member | undefined): ModelToolWorkerCurrent["carrier"] { return !member ? "absent" : member.sessionFile ? "connected" : member.pendingLaunchId ? "starting" : "absent"; }
function resolveWorkerAggregate(cwd: string, leaderCwd: string, trusted?: boolean) { const resources = resolveWorkerLaunchResources({ cwd, leaderCwd, leaderProjectTrusted: trusted }); return { path: resources.aggregatePath, projectTrusted: resources.projectTrusted, defaultModel: resources.policy.defaultModel, modelProfiles: resources.policy.modelProfiles }; }
function compactModelProfiles(profiles: WorkerModelProfiles): Array<{ alias: string; use: string }> { return Object.entries(profiles).sort(([a], [b]) => a.localeCompare(b)).map(([alias, profile]) => ({ alias, use: profile.use })); }
export class DurableModelToolTeamApplication implements ModelToolTeamApplicationPort {
  setLeaderSessionFile: NonNullable<ModelToolTeamApplicationPort["setLeaderSessionFile"]>;
  setLeaderLaunchContext: NonNullable<ModelToolTeamApplicationPort["setLeaderLaunchContext"]>;
  constructor(private readonly bindings: DurableModelToolBindings, private readonly launchBridge?: WorkerLaunchBridge, private readonly lifecycle?: ModelToolLifecycle, private readonly taskAuthority?: TaskAuthorityProvisioningPort) {
    this.setLeaderSessionFile = bindings.setLeaderSessionFile.bind(bindings);
    this.setLeaderLaunchContext = bindings.setLeaderLaunchContext.bind(bindings);
  }
  async createTeam(id: ExactLeaderSessionId, input: { name: string; purpose: string; pane_layout?: TeamPaneLayout }): Promise<CreateTeamPortResult> {
    const sessionFile = this.bindings.sessionFile(id);
    if (!sessionFile) return { kind: "unavailable", reason: "session_binding_unavailable", message: "The model-tool surface requires the exact durable leader Session file." };
    const existing = await teams.resolveCurrentLeadSessionBinding(sessionFile);
    if (existing.status === "bound") return { kind: "refused", reason: "active_team_exists" };
    if (existing.status !== "abstain" || existing.reason === "runtime_metadata_unavailable") return { kind: "unavailable", reason: "session_binding_unavailable", message: "The exact leader Session binding is not uniquely available." };
    const teamName = paths.sanitizeName(input.name); const terminal = getTerminalAdapter();
    if (!terminal) return { kind: "unavailable", reason: "carrier_unavailable", message: "No supported terminal carrier is available for the model-tool Worker." };
    let paneLayout: TeamPaneLayout; let syncLiveness: TeamConfig["syncLiveness"];
    let modelProfiles: Array<{ alias: string; use: string }> = [];
    try { const context = this.bindings.launchContext(id); const leaderCwd = context?.cwd ?? process.cwd(); const settings = loadTeamPaneLayoutSettings({ cwd: leaderCwd, projectTrusted: context?.projectTrusted ?? true }); paneLayout = resolveTeamPaneLayout({ explicit: input.pane_layout, project: settings.project, global: settings.global, backend: terminal.name }); const workerPolicy = loadWorkerResourcePolicy({ cwd: leaderCwd, projectTrusted: context?.projectTrusted ?? true }); modelProfiles = compactModelProfiles(workerPolicy.modelProfiles ?? {}); const policy = loadSyncLivenessSettings(); syncLiveness = { waitSeconds: policy.waitSeconds, nudgeEnabled: policy.nudgeEnabled, nudgeDelaySeconds: policy.nudgeDelaySeconds, policyVersion: policy.policyVersion, ...(policy.diagnostics.length ? { diagnostics: policy.diagnostics } : {}) }; } catch (error) { return { kind: "unavailable", reason: "carrier_unavailable", message: error instanceof Error ? error.message : String(error) }; }
    let authority; try { authority = await this.taskAuthority?.resolve(teamName); } catch (error) { return { kind: "unavailable", reason: "task_authority_unavailable", message: error instanceof Error ? error.message : String(error) }; }
    if (!authority) return { kind: "unavailable", reason: "task_authority_unavailable", message: "The Team Task authority resolver is not attached to this port." };
    try { const config = await teams.withTeamTopologyLease(teamName, (lease) => teams.createTeam(teamName, sessionFile, "lead-agent", input.purpose, process.env.PI_MODEL_TOOL_WORKER_MODEL, undefined, authority.workspace, authority.authorityId, authority.fingerprint, lease, { backend: terminal.name, ...(terminal.currentTargetId?.() ? { leadTarget: { backend: terminal.name, kind: "pane", targetId: terminal.currentTargetId()! } } : {}) }, undefined, paneLayout, syncLiveness)); await this.lifecycle?.teamCreated?.(teamName, sessionFile); return { kind: "created", team: currentTeam(config), modelProfiles }; } catch (error) { return { kind: "unavailable", reason: "team_authority_unavailable", message: error instanceof Error ? error.message : String(error) }; }
  }
  async ensureWorker(id: ExactLeaderSessionId, input: { name: string; scope: string; model?: string }, execution?: EnsureWorkerExecutionContext): Promise<EnsureWorkerPortResult> {
    const bound = await this.bindings.boundTeam(id); if (!bound) return { kind: "no_active_team" }; if (!this.launchBridge) return { kind: "unavailable", reason: "carrier_unavailable", message: "The model-tool Worker launch bridge is not attached to this port." };
    const context = this.bindings.launchContext(id); const cwd = context?.cwd ?? process.cwd();
    const policy = loadWorkerResourcePolicy({ cwd, projectTrusted: context?.projectTrusted ?? true });
    const aggregate = { projectTrusted: context?.projectTrusted ?? true, defaultModel: policy.defaultModel, modelProfiles: policy.modelProfiles };
    const priorLogical = await teams.readLogicalWorker(bound.teamName, input.name);
    let selection;
    try {
      if (priorLogical.kind === "found" && priorLogical.worker.modelProfile) {
        if (input.model !== undefined && priorLogical.worker.modelProfile.alias !== input.model) {
          return { kind: "model_conflict", worker: { name: input.name, scope: priorLogical.worker.scope, carrier: "absent", ...(priorLogical.worker.modelProfile.alias ? { model: priorLogical.worker.modelProfile.alias } : {}) }, message: `Worker ${input.name} is pinned to model profile ${priorLogical.worker.modelProfile.alias ?? "<native/default>"}; refusing ${input.model}.` };
        }
        selection = { model: `${priorLogical.worker.modelProfile.provider}/${priorLogical.worker.modelProfile.model}`, binding: priorLogical.worker.modelProfile };
      } else {
        selection = this.launchBridge.resolveInitialWorkerModel({ teamName: bound.teamName, workerName: input.name, scope: input.scope, cwd, availableModelKeys: execution?.availableModelKeys, ...(input.model !== undefined ? { model: input.model } : {}) }, bound.config, aggregate);
      }
    } catch (error) {
      if (error instanceof WorkerModelProfileConfigurationError) return { kind: "invalid_model_profile", message: error.message, validModelProfiles: error.choices.map((alias) => ({ alias, use: aggregate.modelProfiles?.[alias]?.use ?? "Select this configured model profile." })) };
      return { kind: "unavailable", reason: "carrier_unavailable", message: error instanceof Error ? error.message : String(error) };
    }
    const logical = await teams.ensureLogicalWorker(bound.teamName, { name: input.name, scope: input.scope, ...(priorLogical.kind === "not_found" && selection.binding ? { modelProfile: selection.binding } : {}) });
    if (logical.kind === "contract_gap") return { kind: "no_active_team" }; if (logical.kind === "scope_conflict") return { kind: "scope_conflict", worker: { name: logical.worker.name, scope: logical.worker.scope, carrier: "absent", ...(logical.worker.modelProfile?.alias ? { model: logical.worker.modelProfile.alias } : {}) } };
    try {
      const launch = await this.launchBridge.ensureWorker({ teamName: bound.teamName, workerName: input.name, scope: logical.worker.scope, cwd, workerAggregate: (workerCwd) => resolveWorkerAggregate(workerCwd, cwd, context?.projectTrusted), launchEnvironment: { [MODEL_TOOL_WORKER_MARKER]: "1" }, ...(input.model !== undefined ? { model: input.model } : {}), ...(selection.binding ? { modelProfile: selection.binding } : {}), ...(execution?.availableModelKeys ? { availableModelKeys: execution.availableModelKeys } : {}) });
      return { kind: launch.action === "reused" ? "reused" : "created", worker: { name: logical.worker.name, scope: logical.worker.scope, carrier: launch.action === "reused" ? workerCarrier(launch.member) : launch.startup.observed ? "connected" : "starting", ...(logical.worker.modelProfile?.alias ? { model: logical.worker.modelProfile.alias } : {}) } };
    } catch (error) {
      if (error instanceof WorkerModelConflictError) return { kind: "model_conflict", worker: { name: input.name, scope: input.scope, carrier: "absent", ...(bound.config.logicalWorkers?.find((worker) => worker.name === input.name)?.modelProfile?.alias ? { model: bound.config.logicalWorkers.find((worker) => worker.name === input.name)!.modelProfile!.alias } : {}) }, message: error.message };
      return { kind: "unavailable", reason: "carrier_unavailable", message: error instanceof Error ? error.message : String(error) };
    }
  }
  async stopWorker(id: ExactLeaderSessionId, worker: string): Promise<WorkerStopPortResult> { const bound = await this.bindings.boundTeam(id); if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." }; return this.lifecycle ? this.lifecycle.stopWorker(bound.teamName, worker) : { kind: "unavailable", reason: "carrier_unavailable", message: "The model-tool lifecycle adapter is not attached to the main extension." }; }
  async shutdownTeam(id: ExactLeaderSessionId): Promise<TeamShutdownPortResult> { const bound = await this.bindings.boundTeam(id); if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." }; return this.lifecycle ? this.lifecycle.shutdownTeam(bound.teamName) : { kind: "unavailable", reason: "team_authority_unavailable", message: "The model-tool lifecycle adapter is not attached to the main extension." }; }
}
