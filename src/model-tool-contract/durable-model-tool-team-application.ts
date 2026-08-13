import { getTerminalAdapter } from "../adapters/terminal-registry";
import * as paths from "../utils/paths";
import * as teams from "../utils/teams";
import type { TaskAuthorityProvisioningPort } from "../task-authority/contracts";
import { resolveWorkerLaunchResources } from "../utils/worker-resource-projection";
import { loadTeamPaneLayoutSettings, resolveTeamPaneLayout, type TeamPaneLayout } from "../utils/team-pane-layout";
import type { WorkerLaunchBridge } from "../team-authority/worker-launch-bridge";
import { MODEL_TOOL_WORKER_MARKER } from "./model-tool-constants";
import { loadSyncLivenessSettings } from "../utils/sync-liveness-settings";
import type { Member, TeamConfig } from "../team-authority/contracts";
import type { ModelToolTeamApplicationPort } from "./model-tool-journey-port";
import type { CreateTeamPortResult, EnsureWorkerPortResult, ExactLeaderSessionId, ModelToolTeamCurrent, ModelToolWorkerCurrent, TeamShutdownPortResult, WorkerStopPortResult } from "./model-tool-contracts";
import { DurableModelToolBindings } from "./durable-model-tool-bindings";
import type { TaskOrchestrationPort } from "../task-authority/orchestration";
export interface ModelToolLifecycle { teamCreated?(teamName: string, sessionFile: string): Promise<void>; stopWorker(teamName: string, worker: string): Promise<WorkerStopPortResult>; shutdownTeam(teamName: string): Promise<TeamShutdownPortResult>; }
function currentTeam(config: TeamConfig): ModelToolTeamCurrent { return { name: config.name, purpose: config.description, lifecycle: "active" }; }
function workerCarrier(member: Member | undefined): ModelToolWorkerCurrent["carrier"] { return !member ? "absent" : member.sessionFile ? "connected" : member.pendingLaunchId ? "starting" : "absent"; }
function resolveWorkerAggregate(cwd: string, leaderCwd: string, trusted?: boolean) { const resources = resolveWorkerLaunchResources({ cwd, leaderCwd, leaderProjectTrusted: trusted }); return { path: resources.aggregatePath, projectTrusted: resources.projectTrusted, defaultModel: resources.policy.defaultModel }; }
export class DurableModelToolTeamApplication implements ModelToolTeamApplicationPort {
  setLeaderSessionFile: NonNullable<ModelToolTeamApplicationPort["setLeaderSessionFile"]>;
  setLeaderLaunchContext: NonNullable<ModelToolTeamApplicationPort["setLeaderLaunchContext"]>;
  constructor(private readonly bindings: DurableModelToolBindings, private readonly launchBridge?: WorkerLaunchBridge, private readonly lifecycle?: ModelToolLifecycle, private readonly taskAuthority?: TaskAuthorityProvisioningPort, private readonly taskOrchestration?: Pick<TaskOrchestrationPort, "reconcileReady">) {
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
    try { const context = this.bindings.launchContext(id); const leaderCwd = context?.cwd ?? process.cwd(); const settings = loadTeamPaneLayoutSettings({ cwd: leaderCwd, projectTrusted: context?.projectTrusted ?? true }); paneLayout = resolveTeamPaneLayout({ explicit: input.pane_layout, project: settings.project, global: settings.global, backend: terminal.name }); const policy = loadSyncLivenessSettings(); syncLiveness = { waitSeconds: policy.waitSeconds, nudgeEnabled: policy.nudgeEnabled, nudgeDelaySeconds: policy.nudgeDelaySeconds, policyVersion: policy.policyVersion, ...(policy.diagnostics.length ? { diagnostics: policy.diagnostics } : {}) }; } catch (error) { return { kind: "unavailable", reason: "carrier_unavailable", message: error instanceof Error ? error.message : String(error) }; }
    let authority; try { authority = await this.taskAuthority?.resolve(teamName); } catch (error) { return { kind: "unavailable", reason: "task_authority_unavailable", message: error instanceof Error ? error.message : String(error) }; }
    if (!authority) return { kind: "unavailable", reason: "task_authority_unavailable", message: "The Team Task authority resolver is not attached to this port." };
    try { const config = await teams.withTeamTopologyLease(teamName, (lease) => teams.createTeam(teamName, sessionFile, "lead-agent", input.purpose, process.env.PI_MODEL_TOOL_WORKER_MODEL, undefined, authority.workspace, authority.authorityId, authority.fingerprint, lease, { backend: terminal.name, ...(terminal.currentTargetId?.() ? { leadTarget: { backend: terminal.name, kind: "pane", targetId: terminal.currentTargetId()! } } : {}) }, undefined, paneLayout, syncLiveness)); await this.lifecycle?.teamCreated?.(teamName, sessionFile); return { kind: "created", team: currentTeam(config) }; } catch (error) { return { kind: "unavailable", reason: "team_authority_unavailable", message: error instanceof Error ? error.message : String(error) }; }
  }
  async ensureWorker(id: ExactLeaderSessionId, input: { name: string; scope: string }): Promise<EnsureWorkerPortResult> {
    const bound = await this.bindings.boundTeam(id); if (!bound) return { kind: "no_active_team" }; if (!this.launchBridge) return { kind: "unavailable", reason: "carrier_unavailable", message: "The model-tool Worker launch bridge is not attached to this port." };
    const logical = await teams.ensureLogicalWorker(bound.teamName, input); if (logical.kind === "contract_gap") return { kind: "no_active_team" }; if (logical.kind === "scope_conflict") return { kind: "scope_conflict", worker: { name: logical.worker.name, scope: logical.worker.scope, carrier: "absent" } };
    const context = this.bindings.launchContext(id); const cwd = context?.cwd ?? process.cwd(); let launch;
    try { launch = await this.launchBridge.ensureWorker({ teamName: bound.teamName, workerName: input.name, scope: logical.worker.scope, cwd, workerAggregate: (workerCwd) => resolveWorkerAggregate(workerCwd, cwd, context?.projectTrusted), launchEnvironment: { [MODEL_TOOL_WORKER_MARKER]: "1" } }); } catch (error) { return { kind: "unavailable", reason: "carrier_unavailable", message: error instanceof Error ? error.message : String(error) }; }
    try { await this.taskOrchestration?.reconcileReady(bound.teamName); } catch { /* Worker creation committed; later Task transitions retry. */ }
    return { kind: launch.action === "reused" ? "reused" : "created", worker: { name: logical.worker.name, scope: logical.worker.scope, carrier: launch.action === "reused" ? workerCarrier(launch.member) : launch.startup.observed ? "connected" : "starting" } };
  }
  async stopWorker(id: ExactLeaderSessionId, worker: string): Promise<WorkerStopPortResult> { const bound = await this.bindings.boundTeam(id); if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." }; return this.lifecycle ? this.lifecycle.stopWorker(bound.teamName, worker) : { kind: "unavailable", reason: "carrier_unavailable", message: "The model-tool lifecycle adapter is not attached to the main extension." }; }
  async shutdownTeam(id: ExactLeaderSessionId): Promise<TeamShutdownPortResult> { const bound = await this.bindings.boundTeam(id); if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." }; return this.lifecycle ? this.lifecycle.shutdownTeam(bound.teamName) : { kind: "unavailable", reason: "team_authority_unavailable", message: "The model-tool lifecycle adapter is not attached to the main extension." }; }
}
