import { getTerminalAdapter } from "../adapters/terminal-registry";
import * as paths from "../utils/paths";
import * as teams from "../utils/teams";
import { resolveTeamTaskAuthority } from "./beads-authority-adapter";
import * as teamEvents from "../utils/team-events";
import type { AlertSender } from "../alert-authority/contracts";
import { resolveWorkerLaunchResources } from "../utils/worker-resource-projection";
import { loadTeamPaneLayoutSettings, resolveTeamPaneLayout, type TeamPaneLayout } from "../utils/team-pane-layout";
import type { WorkerLaunchBridge } from "../team-authority/worker-launch-bridge";
import { MODEL_TOOL_WORKER_MARKER } from "./model-tool-constants";
import { taskVersionRef, type TaskVersionRef } from "../task-authority/task-version-ref";
import {
  BeadsTaskAdapter,
  projectNonterminalTaskIds,
  projectTaskChanges,
  type BeadsTaskAdapterFactory,
} from "./beads-task-adapter";
import {
  readHiddenObservationProjection,
} from "../utils/hidden-observation";
import type {
  ExactLeaderSessionId,
  ModelToolLeaderLaunchContext,
  ModelToolTeamCurrent,
  ModelToolTeamPort,
  ModelToolWorkerCurrent,
  PendingObservation,
  ReadTasksPortResult,
  TeamSnapshotPortResult,
  TeamSyncPortResult,
  CreateTeamPortResult,
  EnsureWorkerPortResult,
  CreateTaskPortResult,
  UpdateTasksPortResult,
  TaskUpdatePortOutcome,
  WorkerStopPortResult,
  TeamShutdownPortResult,
  TaskLinkPortInput,
  TaskLinkPortResult,
  AlertSendPortResult,
} from "./in-memory-team-port";
import type { TaskCard } from "../task-authority/task-domain";
import type { ModelToolTaskUpdateInput } from "../task-authority/contracts";
import type { TeamEvent } from "../coordination/contracts";
import type { Member, TeamConfig } from "../team-authority/contracts";
import { exactLeaderSessionId } from "./in-memory-team-port";
import type { CoordinationQueryBundle } from "../coordination/queries";
import { createDurableCoordinationQueries } from "../adapters/durable-coordination-queries";
import { CoordinationObservationService, taskProjectionRevision } from "../coordination/observation-service";
import { loadSyncLivenessSettings } from "../utils/sync-liveness-settings";
import type { SyncNudgeDebt } from "../utils/sync-nudge-conductor";
import { readTaskEventFailureHintsAfter } from "../utils/task-event-failure-hints";

type BoundTeam = { teamName: string; config: TeamConfig; sessionFile: string };

export interface ModelToolLifecycle {
  teamCreated?(teamName: string, sessionFile: string): Promise<void>;
  stopWorker(teamName: string, worker: string): Promise<WorkerStopPortResult>;
  shutdownTeam(teamName: string): Promise<TeamShutdownPortResult>;
}

function currentTeam(config: TeamConfig): ModelToolTeamCurrent {
  return { name: config.name, purpose: config.description, lifecycle: "active" };
}

function latestMember(config: TeamConfig, workerName: string): Member | undefined {
  return [...config.members].reverse().find((member) =>
    member.name === workerName && member.agentType === "teammate" && member.isActive !== false);
}

function workerCarrier(member: Member | undefined): ModelToolWorkerCurrent["carrier"] {
  if (!member) return "absent";
  return member.sessionFile ? "connected" : member.pendingLaunchId ? "starting" : "absent";
}

function resolveWorkerAggregate(cwd: string, leaderCwd: string, leaderProjectTrusted?: boolean) {
  const resources = resolveWorkerLaunchResources({ cwd, leaderCwd, leaderProjectTrusted });
  return { path: resources.aggregatePath, projectTrusted: resources.projectTrusted, defaultModel: resources.policy.defaultModel };
}

/**
 * Durable model-tool adapter. It projects existing Team, Beads, event, and
 * Membership authorities; it owns no Team, Task, Worker, or event store.
 */
export class DurableModelToolTeamPort implements ModelToolTeamPort {
  private readonly sessionFiles = new Map<ExactLeaderSessionId, string>();
  private readonly leaderLaunchContexts = new Map<ExactLeaderSessionId, ModelToolLeaderLaunchContext>();
  private readonly launchBridge?: WorkerLaunchBridge;
  private readonly lifecycle?: ModelToolLifecycle;
  private readonly taskAdapterFactory: BeadsTaskAdapterFactory;
  private readonly alertSender?: AlertSender;
  private readonly coordinationQueries: CoordinationQueryBundle;
  private readonly observationService: CoordinationObservationService;

  constructor(
    launchBridge?: WorkerLaunchBridge,
    lifecycle?: ModelToolLifecycle,
    taskAdapterFactory: BeadsTaskAdapterFactory = (teamName, actor) => new BeadsTaskAdapter(teamName, actor),
    alertSender?: AlertSender,
    coordinationQueries: CoordinationQueryBundle = createDurableCoordinationQueries(),
    observationService: CoordinationObservationService = new CoordinationObservationService(coordinationQueries, { projectNonterminalTaskIds, projectTaskChanges }),
  ) {
    this.launchBridge = launchBridge;
    this.lifecycle = lifecycle;
    this.taskAdapterFactory = taskAdapterFactory;
    this.alertSender = alertSender;
    this.coordinationQueries = coordinationQueries;
    this.observationService = observationService;
  }

  setLeaderSessionFile(leaderSessionId: ExactLeaderSessionId, sessionFile: string): void {
    this.sessionFiles.set(leaderSessionId, sessionFile);
  }

  setLeaderLaunchContext(leaderSessionId: ExactLeaderSessionId, context: ModelToolLeaderLaunchContext): void {
    this.leaderLaunchContexts.set(leaderSessionId, context);
  }

  async createTeam(
    leaderSessionId: ExactLeaderSessionId,
    input: { name: string; purpose: string; pane_layout?: TeamPaneLayout },
  ): Promise<CreateTeamPortResult> {
    const sessionFile = this.sessionFiles.get(leaderSessionId);
    if (!sessionFile) return { kind: "unavailable", reason: "session_binding_unavailable", message: "The model-tool surface requires the exact durable leader Session file." };
    const existing = await teams.resolveCurrentLeadSessionBinding(sessionFile);
    if (existing.status === "bound") return { kind: "refused", reason: "active_team_exists" };
    if (existing.status !== "abstain" || existing.reason === "runtime_metadata_unavailable") {
      return { kind: "unavailable", reason: "session_binding_unavailable", message: "The exact leader Session binding is not uniquely available." };
    }
    const teamName = paths.sanitizeName(input.name);
    const terminal = getTerminalAdapter();
    if (!terminal) return { kind: "unavailable", reason: "carrier_unavailable", message: "No supported terminal carrier is available for the model-tool Worker." };
    let paneLayout: TeamPaneLayout;
    let syncLiveness: TeamConfig["syncLiveness"];
    try {
      const launchContext = this.leaderLaunchContexts.get(leaderSessionId);
      const leaderCwd = launchContext?.cwd ?? process.cwd();
      const projectTrusted = launchContext?.projectTrusted ?? true;
      const settings = loadTeamPaneLayoutSettings({ cwd: leaderCwd, projectTrusted });
      paneLayout = resolveTeamPaneLayout({
        explicit: input.pane_layout,
        project: settings.project,
        global: settings.global,
        backend: terminal.name,
      });
      const policy = loadSyncLivenessSettings();
      syncLiveness = {
        waitSeconds: policy.waitSeconds,
        nudgeEnabled: policy.nudgeEnabled,
        nudgeDelaySeconds: policy.nudgeDelaySeconds,
        policyVersion: policy.policyVersion,
        ...(policy.diagnostics.length ? { diagnostics: policy.diagnostics } : {}),
      };
    } catch (error) {
      return { kind: "unavailable", reason: "carrier_unavailable", message: error instanceof Error ? error.message : String(error) };
    }
    let authority;
    try {
      authority = await resolveTeamTaskAuthority(teamName);
    } catch (error) {
      return { kind: "unavailable", reason: "task_authority_unavailable", message: error instanceof Error ? error.message : String(error) };
    }
    try {
      const config = await teams.withTeamTopologyLease(teamName, (lease) => teams.createTeam(
        teamName,
        sessionFile,
        "lead-agent",
        input.purpose,
        process.env.PI_MODEL_TOOL_WORKER_MODEL,
        undefined,
        authority.workspace,
        authority.authorityId,
        authority.fingerprint,
        lease,
        {
          backend: terminal.name,
          ...(terminal.currentTargetId?.() ? { leadTarget: { backend: terminal.name, kind: "pane", targetId: terminal.currentTargetId()! } } : {}),
        },
        undefined,
        paneLayout,
        syncLiveness,
      ));
      await this.lifecycle?.teamCreated?.(teamName, sessionFile);
      return { kind: "created", team: currentTeam(config) };
    } catch (error) {
      return { kind: "unavailable", reason: "team_authority_unavailable", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async ensureWorker(
    leaderSessionId: ExactLeaderSessionId,
    input: { name: string; scope: string },
  ): Promise<EnsureWorkerPortResult> {
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "no_active_team" };
    if (!this.launchBridge) {
      return { kind: "unavailable", reason: "carrier_unavailable", message: "The model-tool Worker launch bridge is not attached to this port." };
    }
    const logical = await teams.ensureLogicalWorker(bound.teamName, { name: input.name, scope: input.scope });
    if (logical.kind === "contract_gap") return { kind: "no_active_team" };
    if (logical.kind === "scope_conflict") return { kind: "scope_conflict", worker: { name: logical.worker.name, scope: logical.worker.scope, carrier: "absent" } };
    const launchContext = this.leaderLaunchContexts.get(leaderSessionId);
    const leaderCwd = launchContext?.cwd ?? process.cwd();
    let launch;
    try {
      launch = await this.launchBridge.ensureWorker({
        teamName: bound.teamName,
        workerName: input.name,
        scope: logical.worker.scope,
        cwd: leaderCwd,
        workerAggregate: (cwd) => resolveWorkerAggregate(cwd, leaderCwd, launchContext?.projectTrusted),
        launchEnvironment: { [MODEL_TOOL_WORKER_MARKER]: "1" },
      });
    } catch (error) {
      return { kind: "unavailable", reason: "carrier_unavailable", message: error instanceof Error ? error.message : String(error) };
    }
    const member = launch.member;
    const worker = {
      name: logical.worker.name,
      scope: logical.worker.scope,
      carrier: launch.action === "reused"
        ? workerCarrier(member)
        : launch.startup.observed ? "connected" as const : "starting" as const,
    };
    return { kind: launch.action === "reused" ? "reused" : "created", worker };
  }

  async readSnapshot(leaderSessionId: ExactLeaderSessionId): Promise<TeamSnapshotPortResult> {
    const sessionFile = this.sessionFiles.get(leaderSessionId);
    return sessionFile ? await this.observationService.readSnapshot(sessionFile) : { kind: "no_active_team" };
  }

  async createTask(
    leaderSessionId: ExactLeaderSessionId,
    input: { operationId: string; title: string; goal: string; assignee?: string },
  ): Promise<CreateTaskPortResult> {
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "no_active_team", operationId: input.operationId };
    if (input.assignee) {
      const logical = await teams.readLogicalWorker(bound.teamName, input.assignee);
      if (logical.kind !== "found") return { kind: "worker_unavailable", operationId: input.operationId };
    }
    const outcome = await this.taskAdapterFactory(bound.teamName, "team-lead").createWithReceipt(input);
    if (outcome.kind === "created") {
      return { kind: "created", operationId: outcome.operationId, task: outcome.task, ...(outcome.deliveryWarnings.length > 0 ? { deliveryWarnings: outcome.deliveryWarnings } : {}) };
    }
    if (outcome.kind === "operation_conflict") return outcome;
    return outcome;
  }

  async readTasks(leaderSessionId: ExactLeaderSessionId, taskIds: string[]): Promise<ReadTasksPortResult> {
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "no_active_team" };
    const uniqueTaskIds = [...new Set(taskIds)];
    const adapter = this.taskAdapterFactory(bound.teamName, "team-lead");
    try {
      const hydrated = await adapter.readMany(uniqueTaskIds);
      const byId = new Map(uniqueTaskIds.map((taskId, index) => [taskId, hydrated[index]]));
      return {
        kind: "read",
        tasks: taskIds.map((taskId) => {
          const result = byId.get(taskId);
          return result === undefined || result.kind === "found" ? result?.task : result;
        }),
      };
    } catch (error) {
      return {
        kind: "unavailable",
        reason: "task_authority_unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async updateTasks(leaderSessionId: ExactLeaderSessionId, updates: ModelToolTaskUpdateInput[]): Promise<UpdateTasksPortResult> {
    const duplicate = new Set<string>();
    const seen = new Set<string>();
    for (const update of updates) {
      if (seen.has(update.taskId)) duplicate.add(update.taskId);
      seen.add(update.taskId);
    }
    if (duplicate.size > 0) return { kind: "duplicate_task_id" };
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "no_active_team" };
    const adapter = this.taskAdapterFactory(bound.teamName, "team-lead");
    const outcomes: TaskUpdatePortOutcome[] = [];
    for (const input of updates) {
      const result = await adapter.update(input);
      if (result.kind === "updated") {
        outcomes.push({ kind: "updated", taskId: result.taskId, operationId: result.operationId, task: result.task, journalEntries: result.journalEntries });
      } else if (result.kind === "refused") {
        outcomes.push(result);
      } else if ("operationId" in result) {
        outcomes.push({
          kind: "contract_gap",
          taskId: result.taskId,
          operationId: result.operationId,
          reason: result.reason,
          message: result.message,
          currentTask: result.currentTask,
          unsupported: [...result.unsupported],
        });
      } else {
        outcomes.push({
          kind: "contract_gap",
          taskId: input.taskId,
          operationId: input.operationId,
          reason: result.reason,
          message: result.message,
          unsupported: ["task_metadata"],
        });
      }
    }
    return { kind: "batch", outcomes };
  }

  async stopWorker(leaderSessionId: ExactLeaderSessionId, worker: string): Promise<WorkerStopPortResult> {
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    if (!this.lifecycle) return { kind: "unavailable", reason: "carrier_unavailable", message: "The model-tool lifecycle adapter is not attached to the main extension." };
    return this.lifecycle.stopWorker(bound.teamName, worker);
  }

  async shutdownTeam(leaderSessionId: ExactLeaderSessionId): Promise<TeamShutdownPortResult> {
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    if (!this.lifecycle) return { kind: "unavailable", reason: "team_authority_unavailable", message: "The model-tool lifecycle adapter is not attached to the main extension." };
    return this.lifecycle.shutdownTeam(bound.teamName);
  }

  async linkTask(leaderSessionId: ExactLeaderSessionId, input: TaskLinkPortInput): Promise<TaskLinkPortResult> {
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    const lead = [...bound.config.members].reverse().find((member) => member.name === "team-lead" && member.isActive !== false);
    const result = await this.taskAdapterFactory(bound.teamName, "team-lead").link(input, {
      actingSessionFile: bound.sessionFile,
      actingMembershipId: lead?.membershipId,
    });
    return result;
  }

  async sendAlert(leaderSessionId: ExactLeaderSessionId, input: { target: import("./in-memory-team-port").AlertTarget; kind: "clarification" | "attention" | "announcement"; text: string; taskId?: string; taskVersion?: TaskVersionRef }): Promise<AlertSendPortResult> {
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    const lead = [...bound.config.members].reverse().find((member) => member.name === "team-lead" && member.isActive !== false);
    try {
      if (input.target.kind === "team" && input.kind !== "announcement") {
        return { kind: "refused", reason: "invalid_fanout", message: "Only announcement Alerts may target the whole Team." };
      }
      if (!this.alertSender) {
        return { kind: "unavailable", reason: "team_authority_unavailable", message: "The Alert sender is not attached to this model-tool port." };
      }
      const result = await this.alertSender.sendAlert({
        teamName: bound.teamName,
        from: "team-lead",
        to: input.target.kind === "team" ? "*" : input.target.name,
        kind: input.kind,
        text: input.text,
        taskId: input.taskId,
        taskVersion: input.taskVersion,
        expectedSender: lead?.membershipId ? { membershipId: lead.membershipId, sessionFile: bound.sessionFile } : undefined,
      });
      return { kind: "sent", alertId: result.alertId, acceptedRecipients: result.accepted.map((delivery) => delivery.recipient), failedRecipients: result.failures.map((failure) => failure.recipient) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/recipient|not accepted by any current Team member/i.test(message)) {
        return { kind: "refused", reason: input.target.kind === "team" ? "no_eligible_recipients" : "recipient_not_current", message };
      }
      return { kind: "unavailable", reason: "team_authority_unavailable", message };
    }
  }

  async readTeamSync(leaderSessionId: ExactLeaderSessionId, view: "snapshot" | "updates", signal: AbortSignal, toolCallId: string): Promise<TeamSyncPortResult> {
    const sessionFile = this.sessionFiles.get(leaderSessionId);
    return sessionFile
      ? await this.observationService.readTeamSync(sessionFile, view, signal, toolCallId)
      : { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
  }

  async readSyncNudgeDebt(leaderSessionId: ExactLeaderSessionId, branchLineage: string[]): Promise<SyncNudgeDebt> {
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound || !bound.config.syncLiveness?.nudgeEnabled || bound.config.syncLiveness.nudgeDelaySeconds === undefined) return { kind: "none" };
    const branchId = branchLineage.at(-1);
    if (!branchId || new Set(branchLineage).size !== branchLineage.length) return { kind: "none" };
    const lead = [...bound.config.members].reverse().find((member) => member.name === "team-lead" && member.agentType === "lead" && member.isActive !== false && member.sessionFile === bound.sessionFile);
    if (!lead?.membershipId) return { kind: "none" };
    const branchKey = JSON.stringify(branchLineage);
    const observation = await readHiddenObservationProjection(bound.teamName, {
      teamEpochId: bound.config.epochId!,
      exactSessionId: bound.sessionFile,
      branchLineage,
    });
    if (observation.kind === "contract_gap") return { kind: "unavailable", message: `Model-tool ${observation.reason.replaceAll("_", " ")} is unavailable.` };
    const tasksResult = await this.observationService.readTaskProjection(bound.teamName);
    if (tasksResult.kind !== "tasks") return { kind: "unavailable", message: tasksResult.message };
    const events = this.readAllNudgeEvents(bound.teamName, observation.kind === "found" ? observation.projection.teamEventCursor : undefined);
    const currentRevision = taskProjectionRevision(tasksResult.tasks, tasksResult.warnings);
    const currentCursor = events.headCursor;
    const policyVersion = bound.config.syncLiveness.policyVersion;
    if (observation.kind !== "found") {
      const debtKey = `${bound.config.epochId}|${bound.sessionFile}|${lead.membershipId}|${branchKey}|snapshot|${currentCursor}|${currentRevision}|${policyVersion}`;
      return { kind: "eligible", debtKey, requestedView: "snapshot", teamEpochId: bound.config.epochId!, leaderSessionId: bound.sessionFile, leaderMembershipId: lead.membershipId, branchLineage: [...branchLineage], branchId, policyVersion };
    }
    const acknowledgedRevision = observation.projection.authorityRevisions.task_projection;
    const acknowledgedHintCursor = observation.projection.authorityRevisions.task_event_failure_hints ?? "0";
    let hintBatch: ReturnType<typeof readTaskEventFailureHintsAfter>;
    try {
      hintBatch = readTaskEventFailureHintsAfter(bound.teamName, acknowledgedHintCursor, {
        teamEpochId: bound.config.epochId!,
        taskReferences: tasksResult.tasks.map((task) => ({ taskId: task.id, taskVersion: taskVersionRef(task.version) })),
      });
    } catch (error) {
      return { kind: "indeterminate", message: `Failed-event hint evidence is unavailable; automatic sync nudge is suppressed. ${error instanceof Error ? error.message : String(error)}` };
    }
    const hintCursorChanged = hintBatch.headCursor !== acknowledgedHintCursor;
    const externalHint = hintBatch.hints.some((match) => match.actorKind === "non-leader/external");
    const leaderHint = hintBatch.hints.some((match) => match.actorKind === "team-lead");
    const taskEvents = events.events.filter((event) => event.type === "task");
    const nonLeaderTaskChange = taskEvents.some((event) => event.actor !== "team-lead");
    const leaderTaskChange = taskEvents.some((event) => event.actor === "team-lead");
    const pairChanged = observation.projection.teamEventCursor !== currentCursor || acknowledgedRevision !== currentRevision || hintCursorChanged;
    if (!pairChanged) return { kind: "none" };
    if (acknowledgedRevision === currentRevision && !hintCursorChanged && !nonLeaderTaskChange && !leaderTaskChange) return { kind: "none" };
    if (nonLeaderTaskChange || externalHint) {
      const debtKey = `${bound.config.epochId}|${bound.sessionFile}|${lead.membershipId}|${branchKey}|updates|${observation.projection.teamEventCursor}:${acknowledgedRevision}:${acknowledgedHintCursor}->${currentCursor}:${currentRevision}:${hintBatch.headCursor}|${policyVersion}`;
      return { kind: "eligible", debtKey, requestedView: "updates", teamEpochId: bound.config.epochId!, leaderSessionId: bound.sessionFile, leaderMembershipId: lead.membershipId, branchLineage: [...branchLineage], branchId, policyVersion };
    }
    if (leaderTaskChange || leaderHint) return { kind: "none" };
    return { kind: "indeterminate", message: "Task or failed-event evidence changed without actor evidence; automatic sync nudge is suppressed." };
  }

  setPendingObservationResult(leaderSessionId: ExactLeaderSessionId, result: unknown): void { this.observationService.setPendingResult(this.sessionFiles.get(leaderSessionId) ?? leaderSessionId, result); }

  acknowledgePendingObservation(_leaderSessionId: ExactLeaderSessionId, _entryId: string, _branchIds: string[]): boolean { return false; }

  async acknowledgePendingObservationAsync(leaderSessionId: ExactLeaderSessionId, entryId: string, branchIds: string[]): Promise<boolean> {
    return await this.observationService.acknowledge(this.sessionFiles.get(leaderSessionId) ?? leaderSessionId, entryId, branchIds);
  }

  setBranchContext(leaderSessionId: ExactLeaderSessionId, branchIds: string[]): void { this.observationService.setBranchContext(this.sessionFiles.get(leaderSessionId) ?? leaderSessionId, branchIds); }

  getPendingObservation(leaderSessionId: ExactLeaderSessionId): PendingObservation | undefined {
    const pending = this.observationService.pending(this.sessionFiles.get(leaderSessionId) ?? leaderSessionId);
    return pending ? { sessionId: pending.sessionId, toolCallId: pending.toolCallId, resultText: pending.resultText, resultDigest: pending.resultDigest, head: pending.head, epochId: pending.epochId } : undefined;
  }

  private async boundTeam(leaderSessionId: ExactLeaderSessionId): Promise<BoundTeam | undefined> {
    const sessionFile = this.sessionFiles.get(leaderSessionId);
    if (!sessionFile) return undefined;
    const binding = await teams.resolveCurrentLeadSessionBinding(sessionFile);
    if (binding.status !== "bound") return undefined;
    const config = await teams.readConfig(binding.teamName);
    return { teamName: binding.teamName, config, sessionFile };
  }

  private readAllNudgeEvents(teamName: string, afterCursor?: string): { events: TeamEvent[]; headCursor: string } {
    const events: TeamEvent[] = [];
    let cursor = afterCursor;
    let page: teamEvents.TeamEventBatch;
    do {
      page = teamEvents.readTeamEvents(teamName, { ...(cursor === undefined ? {} : { afterCursor: cursor }) });
      events.push(...page.events);
      if (!page.truncated) return { events, headCursor: page.headCursor };
      if (page.cursor === cursor) throw new Error("Team nudge event pagination did not advance.");
      cursor = page.cursor;
    } while (page.truncated);
    return { events, headCursor: page.headCursor };
  }




}

export function durableModelToolLeaderSessionId(value: string): ExactLeaderSessionId {
  return exactLeaderSessionId(value);
}
