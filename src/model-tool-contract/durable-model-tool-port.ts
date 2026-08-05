import { getTerminalAdapter } from "../adapters/terminal-registry";
import crypto from "node:crypto";
import * as paths from "../utils/paths";
import * as teams from "../utils/teams";
import { listTaskIds, resolveTeamTaskAuthority } from "./beads-authority-adapter";
import * as teamEvents from "../utils/team-events";
import * as alerts from "../utils/alerts";
import { resolveQualifiedWorkerDefaultModel, resolveWorkerLaunchResources } from "../utils/worker-resource-projection";
import { loadTeamPaneLayoutSettings, resolveTeamPaneLayout, type TeamPaneLayout } from "../utils/team-pane-layout";
import { createWorkerLaunchBridge, type WorkerLaunchBridge } from "../utils/worker-launch-bridge";
import { MODEL_TOOL_IMPLEMENTATION_VERSION, MODEL_TOOL_WORKER_MARKER } from "./model-tool-constants";
import { taskVersionRef, type TaskVersionRef } from "./task-version-ref";
import {
  BeadsTaskAdapter,
  projectNonterminalTaskIds,
  projectTaskChanges,
  type TaskChangeProjection,
} from "./beads-task-adapter";
import {
  commitHiddenObservationProjection,
  readHiddenObservationProjection,
  type HiddenObservationProjection,
} from "../utils/hidden-observation";
import type {
  ExactLeaderSessionId,
  ModelToolLeaderLaunchContext,
  ModelToolTaskJournalEntry,
  ModelToolTeamCurrent,
  ModelToolTeamPort,
  ModelToolWorkerCurrent,
  PendingObservation,
  ReadTaskContractGap,
  ReadTasksPortResult,
  TeamSnapshotPortResult,
  TeamSyncPortResult,
  CreateTeamPortResult,
  EnsureWorkerPortResult,
  CreateTaskPortResult,
  UpdateTasksPortResult,
  TaskUpdatePortOutcome,
  ModelToolTaskUpdateInput,
  WorkerStopPortResult,
  TeamShutdownPortResult,
  TaskLinkPortInput,
  TaskLinkPortResult,
  AlertSendPortResult,
} from "./in-memory-team-port";
import type { TaskCard, TaskCardWarning } from "./task-domain";
import type { Member, TeamConfig, TeamEvent } from "../utils/models";
import { exactLeaderSessionId } from "./in-memory-team-port";
const WAIT_MS = 120_000;

type PendingDurableObservation = PendingObservation & {
  internalResult: TeamSyncPortResult;
  teamName: string;
  view: "snapshot" | "updates";
  authorityRevisions: Record<string, string>;
};

type BoundTeam = { teamName: string; config: TeamConfig; sessionFile: string };

export interface ModelToolLifecycle {
  teamCreated?(teamName: string, sessionFile: string): Promise<void>;
  stopWorker(teamName: string, worker: string): Promise<WorkerStopPortResult>;
  shutdownTeam(teamName: string): Promise<TeamShutdownPortResult>;
}

function taskProjectionRevision(tasks: readonly TaskCard[], warnings: readonly TaskCardWarning[] = []): string {
  return crypto.createHash("sha256").update(JSON.stringify({ tasks, warnings })).digest("hex");
}

function asNumber(cursor: string): number {
  const value = Number(cursor);
  return Number.isSafeInteger(value) ? value : 0;
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

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function workerEventChange(event: Extract<TeamEvent, { type: "worker" }>): "created" | "connected" | "stopped" | "failed" {
  if (event.phase === "prepared") return "created";
  if (event.phase === "session_bound") return "connected";
  return event.phase;
}

/**
 * Durable model-tool adapter. It projects existing Team, Beads, event, and
 * Membership authorities; it owns no Team, Task, Worker, or event store.
 */
export class DurableModelToolTeamPort implements ModelToolTeamPort {
  private readonly sessionFiles = new Map<ExactLeaderSessionId, string>();
  private readonly leaderLaunchContexts = new Map<ExactLeaderSessionId, ModelToolLeaderLaunchContext>();
  private readonly branchIds = new Map<ExactLeaderSessionId, string[]>();
  private readonly pending = new Map<ExactLeaderSessionId, PendingDurableObservation>();
  private readonly defaultLaunchBridge = createWorkerLaunchBridge({
    buildWorkerArgv: (model, thinking, aggregatePath, projectTrusted) => {
      const argv = process.argv[1] ? [process.execPath, process.argv[1]] : ["pi"];
      const result = [...argv];
      if (model) result.push("--model", thinking ? `${model}:${thinking}` : model);
      else if (thinking) result.push("--thinking", thinking);
      const shippedExtension = process.env.PI_TEAM_BRIGHT_SHIPPED_EXTENSION;
      if (shippedExtension) result.push("-e", shippedExtension);
      if (aggregatePath) result.push("--no-context-files", "--append-system-prompt", aggregatePath);
      result.push(projectTrusted ? "--approve" : "--no-approve");
      return result;
    },
    resolveModel: () => null,
    resolveSettingsModel: resolveQualifiedWorkerDefaultModel,
    workerAggregate: (cwd) => resolveWorkerAggregate(cwd, process.cwd()),
  });
  private readonly launchBridge: WorkerLaunchBridge;
  private readonly lifecycle?: ModelToolLifecycle;

  constructor(launchBridge?: WorkerLaunchBridge, lifecycle?: ModelToolLifecycle) {
    this.launchBridge = launchBridge ?? this.defaultLaunchBridge;
    this.lifecycle = lifecycle;
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
        MODEL_TOOL_IMPLEMENTATION_VERSION,
        paneLayout,
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
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "no_active_team" };
    const gap = teams.teamModelToolContractGap(bound.config);
    if (gap) return { ...gap, message: `Model-tool ${gap.reason.replaceAll("_", " ")} is unavailable for Team ${bound.teamName}.` };
    try {
      const tasks = await this.readModelToolTasks(bound.teamName);
      if (tasks.kind === "contract_gap") return tasks;
      const workers = this.readWorkers(bound, tasks.tasks);
      return { kind: "snapshot", team: currentTeam(bound.config), workers, tasks: tasks.tasks, ...(tasks.warnings.length ? { taskProjectionWarnings: tasks.warnings } : {}) };
    } catch (error) {
      return { kind: "contract_gap", reason: "structured_task_event_evidence_absent", message: error instanceof Error ? error.message : String(error) };
    }
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
    const outcome = await new BeadsTaskAdapter(bound.teamName, "team-lead").createWithReceipt(input);
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
    const adapter = new BeadsTaskAdapter(bound.teamName, "team-lead");
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
    const adapter = new BeadsTaskAdapter(bound.teamName, "team-lead");
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
    const result = await new BeadsTaskAdapter(bound.teamName, "team-lead").link(input, {
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
      const result = await alerts.sendAlert({
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

  async readTeamSync(
    leaderSessionId: ExactLeaderSessionId,
    view: "snapshot" | "updates",
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<TeamSyncPortResult> {
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    const gap = teams.teamModelToolContractGap(bound.config);
    if (gap) return { kind: "contract_gap", reason: gap.reason, message: `Model-tool ${gap.reason.replaceAll("_", " ")} is unavailable for Team ${bound.teamName}.` };
    const pending = this.pending.get(leaderSessionId);
    if (pending) return pending.internalResult;
    const branchLineage = this.branchIds.get(leaderSessionId) ?? [];
    if (view === "updates") {
      const observation = await readHiddenObservationProjection(bound.teamName, {
        teamEpochId: bound.config.epochId!,
        exactSessionId: bound.sessionFile,
        branchLineage,
      });
      if (observation.kind === "contract_gap") return { ...observation, message: `Model-tool ${observation.reason.replaceAll("_", " ")} is unavailable for Team ${bound.teamName}.` };
      if (observation.kind !== "found") {
        return { kind: "snapshot_required", message: "Take a Team snapshot before requesting updates." };
      }
      let tasksResult = await this.readModelToolTasks(bound.teamName);
      if (tasksResult.kind === "contract_gap") return tasksResult;
      let batch = teamEvents.readTeamEvents(bound.teamName, { afterCursor: observation.projection.teamEventCursor });
      const taskRevisionChanged = observation.projection.authorityRevisions.task_projection !== taskProjectionRevision(tasksResult.tasks, tasksResult.warnings);
      if (batch.events.length === 0 && !taskRevisionChanged) {
        try {
          const waited = await teamEvents.waitForTeamEvents({ teamName: bound.teamName, afterCursor: observation.projection.teamEventCursor, waitMs: WAIT_MS, signal });
          batch = waited;
          tasksResult = await this.readModelToolTasks(bound.teamName);
          if (tasksResult.kind === "contract_gap") return tasksResult;
        } catch (error) {
          if (isAbort(error)) return { kind: "cancelled", message: "The updates wait was cancelled before an observation was published." };
          throw error;
        }
      }
      const result = await this.projectUpdates(bound, batch.events, observation.projection, tasksResult.tasks, taskRevisionChanged, tasksResult.warnings);
      if (result.kind === "contract_gap") return result;
      this.stage(leaderSessionId, bound.sessionFile, toolCallId, result, asNumber(batch.headCursor), bound.config.epochId!, bound.teamName, view, {
        team_events: String(asNumber(batch.headCursor)),
        task_projection: taskProjectionRevision(tasksResult.tasks, tasksResult.warnings),
      });
      return result;
    }
    const snapshot = await this.readSnapshot(leaderSessionId);
    if (snapshot.kind !== "snapshot") {
      if (snapshot.kind === "contract_gap") return snapshot;
      return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    }
    const head = teamEvents.readTeamEventCursor(bound.teamName);
    const result: Extract<TeamSyncPortResult, { kind: "snapshot" }> = { ...snapshot, head: asNumber(head), epochId: bound.config.epochId! };
    this.stage(leaderSessionId, bound.sessionFile, toolCallId, result, asNumber(head), bound.config.epochId!, bound.teamName, view, {
      team_events: String(asNumber(head)),
      task_projection: taskProjectionRevision(result.tasks, result.taskProjectionWarnings),
    });
    return result;
  }

  setPendingObservationResult(leaderSessionId: ExactLeaderSessionId, result: unknown): void {
    const pending = this.pending.get(leaderSessionId);
    if (!pending) return;
    const resultText = JSON.stringify(result);
    pending.resultText = resultText;
    pending.resultDigest = "";
  }

  acknowledgePendingObservation(_leaderSessionId: ExactLeaderSessionId, _entryId: string, _branchIds: string[]): boolean {
    return false;
  }

  async acknowledgePendingObservationAsync(leaderSessionId: ExactLeaderSessionId, entryId: string, branchIds: string[]): Promise<boolean> {
    const pending = this.pending.get(leaderSessionId);
    if (!pending || !branchIds.includes(entryId)) return false;
    const coordinate = {
      teamEpochId: pending.epochId,
      exactSessionId: pending.sessionId,
      branchLineage: branchIds,
      acknowledgedEntryId: entryId,
      teamEventCursor: String(pending.head),
      authorityRevisions: pending.authorityRevisions,
    };
    const committed = await commitHiddenObservationProjection(pending.teamName, coordinate);
    if (committed.kind !== "committed") return false;
    this.pending.delete(leaderSessionId);
    return true;
  }

  setBranchContext(leaderSessionId: ExactLeaderSessionId, branchIds: string[]): void {
    this.branchIds.set(leaderSessionId, branchIds);
  }

  getPendingObservation(leaderSessionId: ExactLeaderSessionId): PendingObservation | undefined {
    const pending = this.pending.get(leaderSessionId);
    if (!pending) return undefined;
    return { sessionId: pending.sessionId, toolCallId: pending.toolCallId, resultText: pending.resultText, resultDigest: pending.resultDigest, head: pending.head, epochId: pending.epochId };
  }

  private async boundTeam(leaderSessionId: ExactLeaderSessionId): Promise<BoundTeam | undefined> {
    const sessionFile = this.sessionFiles.get(leaderSessionId);
    if (!sessionFile) return undefined;
    const binding = await teams.resolveCurrentLeadSessionBinding(sessionFile);
    if (binding.status !== "bound") return undefined;
    const config = await teams.readConfig(binding.teamName);
    if (config.implementationVersion !== MODEL_TOOL_IMPLEMENTATION_VERSION) return undefined;
    return { teamName: binding.teamName, config, sessionFile };
  }

  private async readModelToolTasks(teamName: string): Promise<{ kind: "tasks"; tasks: TaskCard[]; warnings: TaskCardWarning[] } | Extract<TeamSyncPortResult, { kind: "contract_gap" }>> {
    const taskIds = await listTaskIds(teamName);
    const adapter = new BeadsTaskAdapter(teamName, "team-lead");
    const records = await adapter.readMany(taskIds);
    const projected: TaskCard[] = [];
    const warnings: TaskCardWarning[] = [];
    for (const result of records) {
      if (!result) throw new Error("A listed Task disappeared before exact hydration completed.");
      if (result.kind === "contract_gap") return result;
      projected.push(result.task);
    }
    for (const task of projected) warnings.push(...(task.projection_warnings ?? []));
    return { kind: "tasks", tasks: projected, warnings };
  }

  private readWorkers(bound: BoundTeam, taskProjection: TaskCard[]): Array<ModelToolWorkerCurrent & { nonterminalTaskIds: string[] }> {
    return (bound.config.logicalWorkers ?? []).map((logical) => {
      const member = latestMember(bound.config, logical.name);
      return {
        name: logical.name,
        scope: logical.scope,
        carrier: workerCarrier(member),
        nonterminalTaskIds: projectNonterminalTaskIds(taskProjection, logical.name),
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
  }

  private async projectUpdates(bound: BoundTeam, events: TeamEvent[], observation: HiddenObservationProjection, taskProjection?: TaskCard[], taskRevisionChanged = false, taskWarnings: TaskCardWarning[] = []): Promise<Extract<TeamSyncPortResult, { kind: "updates" }> | Extract<TeamSyncPortResult, { kind: "contract_gap" }>> {
    const taskResult = taskProjection ? { kind: "tasks" as const, tasks: taskProjection, warnings: taskWarnings } : await this.readModelToolTasks(bound.teamName);
    if (taskResult.kind !== "tasks") return taskResult;
    const workerChanges: Array<{ worker: string; scope: string; kind: "created" | "connected" | "stopped" | "failed" | "scope_changed"; text: string }> = [];
    for (const event of events) {
      if (event.type !== "worker") continue;
      const logical = bound.config.logicalWorkers?.find((worker) => worker.name === event.worker);
      if (!logical) continue;
      workerChanges.push({ worker: logical.name, scope: logical.scope, kind: workerEventChange(event), text: `Worker ${logical.name} ${event.phase.replaceAll("_", " ")}.` });
    }
    const taskChanges = events.length > 0
      ? projectTaskChanges(events, taskResult.tasks)
      : { kind: "projected" as const, changes: taskRevisionChanged ? taskResult.tasks.map((task) => ({
        taskId: task.id,
        changeKinds: ["progress" as const],
        journalEntries: [],
        current: task,
      })) : [] };
    if (taskChanges.kind === "contract_gap") return taskChanges;
    const result: Extract<TeamSyncPortResult, { kind: "updates" }> = {
      kind: "updates",
      teamChanges: [],
      workerChanges,
      taskChanges: taskChanges.changes,
      alerts: [],
      head: events.length === 0 ? asNumber(observation.teamEventCursor) : Math.max(...events.map((event) => asNumber(event.cursor))),
      epochId: bound.config.epochId!,
      ...(taskResult.warnings.length ? { taskProjectionWarnings: taskResult.warnings } : {}),
    };
    return result;
  }

  private stage(leaderSessionId: ExactLeaderSessionId, exactSessionFile: string, toolCallId: string, result: TeamSyncPortResult, head: number, epochId: string, teamName: string, view: "snapshot" | "updates", authorityRevisions: Record<string, string> = { team_events: String(head) }): void {
    this.pending.set(leaderSessionId, {
      sessionId: exactSessionFile,
      toolCallId,
      resultText: "",
      resultDigest: "",
      head,
      epochId,
      internalResult: result,
      teamName,
      view,
      authorityRevisions,
    });
  }
}

export function durableModelToolLeaderSessionId(value: string): ExactLeaderSessionId {
  return exactLeaderSessionId(value);
}
