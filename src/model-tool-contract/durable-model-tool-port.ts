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
import { currentMember, livenessIsComplete, livenessIsProductive, readWorkerRunObservation, waitForLivenessHint, type WorkerRunObservation } from "../utils/sync-liveness";
import { DEFAULT_SYNC_WAIT_SECONDS, loadSyncLivenessSettings } from "../utils/sync-liveness-settings";
import type { SyncNudgeDebt } from "../utils/sync-nudge-conductor";
import { readTaskEventFailureHintsAfter } from "../utils/task-event-failure-hints";

type TaskProjection = { tasks: TaskCard[]; warnings: TaskCardWarning[] };

type TaskProjectionCache = {
  teamName: string;
  epochId: string;
  exactSessionId: string;
  acknowledgedEntryId: string;
  acknowledgedLineage: string[];
  teamEventCursor: string;
  projection: TaskProjection;
};

type PendingDurableObservation = PendingObservation & {
  internalResult: TeamSyncPortResult;
  teamName: string;
  view: "snapshot" | "updates";
  authorityRevisions: Record<string, string>;
  taskProjection?: TaskProjection;
};

type BoundTeam = { teamName: string; config: TeamConfig; sessionFile: string };

export interface ModelToolLifecycle {
  teamCreated?(teamName: string, sessionFile: string): Promise<void>;
  stopWorker(teamName: string, worker: string): Promise<WorkerStopPortResult>;
  shutdownTeam(teamName: string): Promise<TeamShutdownPortResult>;
}

export function taskProjectionRevision(tasks: readonly TaskCard[], warnings: readonly TaskCardWarning[] = []): string {
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
  /** Complete Task projections are rebuildable, keyed, and acknowledgement-gated baselines. */
  private readonly taskProjections = new Map<string, TaskProjectionCache>();
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
        ...(policy.nudgeDelaySeconds === undefined ? {} : { nudgeDelaySeconds: policy.nudgeDelaySeconds }),
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
        MODEL_TOOL_IMPLEMENTATION_VERSION,
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
      // Read the event batch first. Task events identify the smallest authority
      // read needed for this update; Worker-only events do not read Tasks when a
      // baseline is bound to this exact Team, epoch, Session, branch, and cursor.
      let batch = teamEvents.readTeamEvents(bound.teamName, { afterCursor: observation.projection.teamEventCursor });
      let tasksResult: TaskProjection | undefined;
      let taskRevisionChanged = false;
      let externallyChangedTaskIds: string[] = [];
      if (batch.events.length === 0) {
        // A quiet journal cannot prove that an external Task writer did not
        // change state, so read the complete authority projection first.
        const complete = await this.readModelToolTasks(bound.teamName);
        if (complete.kind === "contract_gap") return complete;
        tasksResult = complete;
        taskRevisionChanged = observation.projection.authorityRevisions.task_projection !== taskProjectionRevision(tasksResult.tasks, tasksResult.warnings);
        if (!taskRevisionChanged) {
          const observations = await this.workerRunObservations(bound);
          if (livenessIsComplete(observations)) {
            // Keep the hardened eventless Task rescan path for logical Workers
            // whose current Membership is absent. A zero-delay authority read
            // preserves the old event check without adding a liveness wait.
            const allAbsent = observations.length > 0 && observations.every((item) => item.state === "absent");
            if (allAbsent) {
              try {
                batch = await teamEvents.waitForTeamEvents({ teamName: bound.teamName, afterCursor: observation.projection.teamEventCursor, waitMs: 0, signal });
                const beforeWait = tasksResult;
                const rechecked = await this.readModelToolTasks(bound.teamName);
                if (rechecked.kind === "contract_gap") return rechecked;
                tasksResult = rechecked;
                externallyChangedTaskIds = beforeWait ? this.changedTaskIds(beforeWait, rechecked) : [];
                taskRevisionChanged = observation.projection.authorityRevisions.task_projection !== taskProjectionRevision(tasksResult.tasks, tasksResult.warnings);
              } catch (error) {
                if (isAbort(error)) return { kind: "cancelled", message: "The updates wait was cancelled before an observation was published." };
                throw error;
              }
              if (batch.events.length > 0 || taskRevisionChanged) {
                // Continue through canonical event hydration and projection.
              } else {
                const result: Extract<TeamSyncPortResult, { kind: "caught_up" }> = { kind: "caught_up", head: asNumber(batch.headCursor), epochId: bound.config.epochId! };
                this.stage(leaderSessionId, bound.sessionFile, toolCallId, result, asNumber(batch.headCursor), bound.config.epochId!, bound.teamName, view, {
                  team_events: String(asNumber(batch.headCursor)),
                  task_projection: taskProjectionRevision(tasksResult.tasks, tasksResult.warnings),
                  task_event_failure_hints: this.taskEventFailureHintCursor(bound.teamName, bound.config.epochId!, tasksResult.tasks, observation.projection.authorityRevisions.task_event_failure_hints ?? "0"),
                }, tasksResult);
                return result;
              }
            } else {
              const result: Extract<TeamSyncPortResult, { kind: "caught_up" }> = { kind: "caught_up", head: asNumber(batch.headCursor), epochId: bound.config.epochId! };
              this.stage(leaderSessionId, bound.sessionFile, toolCallId, result, asNumber(batch.headCursor), bound.config.epochId!, bound.teamName, view, {
                team_events: String(asNumber(batch.headCursor)),
                task_projection: taskProjectionRevision(tasksResult.tasks, tasksResult.warnings),
                task_event_failure_hints: this.taskEventFailureHintCursor(bound.teamName, bound.config.epochId!, tasksResult.tasks, observation.projection.authorityRevisions.task_event_failure_hints ?? "0"),
              }, tasksResult);
              return result;
            }
          }
          if (!livenessIsProductive(observations) && !(batch.events.length > 0 || taskRevisionChanged)) return { kind: "indeterminate", message: "Worker run-state evidence is incomplete; no observation was published." };
          if (batch.events.length === 0 && !taskRevisionChanged) {
          try {
            const waitMs = Math.max(0, (bound.config.syncLiveness?.waitSeconds ?? DEFAULT_SYNC_WAIT_SECONDS) * 1000);
            const producerHint = async (): Promise<boolean> => {
              const next = teamEvents.readTeamEvents(bound.teamName, { afterCursor: observation.projection.teamEventCursor });
              if (next.events.length > 0) return true;
              const current = await this.workerRunObservations(bound);
              return current.some((item, index) => item.state !== observations[index]?.state || item.actuationPending !== observations[index]?.actuationPending);
            };
            const authorityHint = async (): Promise<boolean> => {
              if (await producerHint()) return true;
              const currentTasks = await this.readModelToolTasks(bound.teamName);
              return currentTasks.kind === "tasks" && observation.projection.authorityRevisions.task_projection !== taskProjectionRevision(currentTasks.tasks, currentTasks.warnings);
            };
            await waitForLivenessHint({ teamName: bound.teamName, waitMs, signal, authorityCheckMs: 5_000, check: producerHint, checkAuthority: authorityHint });
            batch = teamEvents.readTeamEvents(bound.teamName, { afterCursor: observation.projection.teamEventCursor });
            const beforeWait = tasksResult;
            const rechecked = await this.readModelToolTasks(bound.teamName);
            if (rechecked.kind === "contract_gap") return rechecked;
            tasksResult = rechecked;
            externallyChangedTaskIds = beforeWait ? this.changedTaskIds(beforeWait, rechecked) : [];
            taskRevisionChanged = observation.projection.authorityRevisions.task_projection !== taskProjectionRevision(tasksResult.tasks, tasksResult.warnings);
            if (batch.events.length === 0 && !taskRevisionChanged) {
              const afterWait = await this.workerRunObservations(bound);
              if (livenessIsComplete(afterWait)) {
                const result: Extract<TeamSyncPortResult, { kind: "caught_up" }> = { kind: "caught_up", head: asNumber(batch.headCursor), epochId: bound.config.epochId! };
                this.stage(leaderSessionId, bound.sessionFile, toolCallId, result, asNumber(batch.headCursor), bound.config.epochId!, bound.teamName, view, {
                  team_events: String(asNumber(batch.headCursor)),
                  task_projection: taskProjectionRevision(tasksResult.tasks, tasksResult.warnings),
                  task_event_failure_hints: this.taskEventFailureHintCursor(bound.teamName, bound.config.epochId!, tasksResult.tasks, observation.projection.authorityRevisions.task_event_failure_hints ?? "0"),
                }, tasksResult);
                return result;
              }
              return { kind: "indeterminate", message: "Worker run-state evidence is incomplete after the bounded wait; no observation was published." };
            }
          } catch (error) {
            if (isAbort(error)) return { kind: "cancelled", message: "The updates wait was cancelled before an observation was published." };
            throw error;
          }
          }
        }
      }

      if (batch.events.length > 0) {
        const baseline = tasksResult ?? this.cachedTaskProjection(bound, observation.projection);
        if (!baseline) {
          // A restarted port has no memory cache. A complete authority rescan
          // is the safe recovery path; it is never merged from another branch.
          const recovered = await this.readModelToolTasks(bound.teamName);
          if (recovered.kind === "contract_gap") return recovered;
          tasksResult = recovered;
        } else {
          tasksResult = baseline;
        }
        const idsToHydrate = this.staleEventTaskIds(batch.events, tasksResult);
        if (idsToHydrate.length > 0) {
          const refreshed = await this.hydrateTaskIds(bound.teamName, idsToHydrate);
          tasksResult = this.mergeTaskProjection(tasksResult, refreshed);
        }
      }
      if (!tasksResult) {
        throw new Error("Task authority did not produce a complete Team observation.");
      }
      const projected = await this.projectUpdates(bound, batch.events, observation.projection, tasksResult.tasks, taskRevisionChanged, tasksResult.warnings, externallyChangedTaskIds);
      if (projected.kind === "contract_gap") return projected;
      // The page cursor is the last event represented in this result. The
      // journal head may include later pages that have not been projected.
      const pageCursor = asNumber(batch.cursor);
      this.stage(leaderSessionId, bound.sessionFile, toolCallId, projected, pageCursor, bound.config.epochId!, bound.teamName, view, {
        team_events: String(pageCursor),
        task_projection: taskProjectionRevision(tasksResult.tasks, tasksResult.warnings),
        task_event_failure_hints: this.taskEventFailureHintCursor(bound.teamName, bound.config.epochId!, tasksResult.tasks, observation.projection.authorityRevisions.task_event_failure_hints ?? "0"),
      }, tasksResult);
      return projected;
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
      task_event_failure_hints: this.taskEventFailureHintCursor(bound.teamName, bound.config.epochId!, result.tasks, "0"),
    }, { tasks: result.tasks, warnings: result.taskProjectionWarnings ?? [] });
    return result;
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
    const tasksResult = await this.readModelToolTasks(bound.teamName);
    if (tasksResult.kind === "contract_gap") return { kind: "unavailable", message: tasksResult.message };
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
    if (pending.taskProjection) {
      const projection = committed.projection;
      this.taskProjections.set(this.taskProjectionKey(pending.teamName, pending.epochId, pending.sessionId), {
        teamName: pending.teamName,
        epochId: pending.epochId,
        exactSessionId: pending.sessionId,
        acknowledgedEntryId: projection.acknowledgedEntryId,
        acknowledgedLineage: [...projection.acknowledgedLineage],
        teamEventCursor: projection.teamEventCursor,
        projection: structuredClone(pending.taskProjection),
      });
    }
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

  private taskEventFailureHintCursor(teamName: string, teamEpochId: string, tasks: readonly TaskCard[], afterCursor: string): string {
    return readTaskEventFailureHintsAfter(teamName, afterCursor, {
      teamEpochId,
      taskReferences: tasks.map((task) => ({ taskId: task.id, taskVersion: taskVersionRef(task.version) })),
    }).headCursor;
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

  private async readModelToolTasks(teamName: string): Promise<{ kind: "tasks"; tasks: TaskCard[]; warnings: TaskCardWarning[] } | Extract<TeamSyncPortResult, { kind: "contract_gap" }>> {
    const taskIds = await listTaskIds(teamName);
    const adapter = new BeadsTaskAdapter(teamName, "team-lead");
    const records = await adapter.readMany(taskIds);
    this.assertCompleteTaskBatch(taskIds, records, "listed Task");
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

  private taskProjectionKey(teamName: string, epochId: string, exactSessionId: string): string {
    return JSON.stringify([teamName, epochId, exactSessionId]);
  }

  private cachedTaskProjection(
    bound: BoundTeam,
    observation: HiddenObservationProjection,
  ): TaskProjection | undefined {
    const cached = this.taskProjections.get(this.taskProjectionKey(bound.teamName, bound.config.epochId!, bound.sessionFile));
    if (
      !cached
      || cached.teamName !== bound.teamName
      || cached.epochId !== bound.config.epochId
      || cached.exactSessionId !== bound.sessionFile
      || cached.acknowledgedEntryId !== observation.acknowledgedEntryId
      || cached.teamEventCursor !== observation.teamEventCursor
      || JSON.stringify(cached.acknowledgedLineage) !== JSON.stringify(observation.acknowledgedLineage)
    ) return undefined;
    return structuredClone(cached.projection);
  }

  private staleEventTaskIds(events: readonly TeamEvent[], baseline: TaskProjection): string[] {
    const currentById = new Map(baseline.tasks.map((task) => [task.id, task]));
    const stale = new Set<string>();
    for (const event of events) {
      const reference = event.type === "task"
        ? event.ref
        : event.type === "alert" && event.taskRef
          ? event.taskRef
          : undefined;
      if (!reference) continue;
      const current = currentById.get(reference.taskId);
      if (!current || (reference.version !== undefined && current.version !== reference.version)) stale.add(reference.taskId);
    }
    return [...stale];
  }

  private assertCompleteTaskBatch(
    taskIds: readonly string[],
    records: readonly (import("./beads-task-adapter").TaskReadOutcome | undefined)[],
    subject: string,
  ): void {
    if (records.length !== taskIds.length) {
      throw new Error(`The Task authority returned ${records.length} outcomes for ${taskIds.length} requested ${subject} IDs.`);
    }
    for (let index = 0; index < taskIds.length; index++) {
      const record = records[index];
      if (!record) throw new Error(`Task ${taskIds[index]} could not be hydrated; the Task authority returned no outcome for ${subject}.`);
      if (record.kind === "contract_gap") throw new Error(record.message);
      if (record.task.id !== taskIds[index]) {
        throw new Error(`The Task authority returned ${record.task.id} for requested ${subject} ${taskIds[index]}.`);
      }
    }
  }

  /** Hydrate selected event Task IDs with one canonical multi-ID authority read. */
  private async hydrateTaskIds(teamName: string, taskIds: readonly string[]): Promise<TaskProjection> {
    if (taskIds.length === 0) return { tasks: [], warnings: [] };
    const adapter = new BeadsTaskAdapter(teamName, "team-lead");
    const records = await adapter.readMany(taskIds);
    this.assertCompleteTaskBatch(taskIds, records, "event Task");
    const tasks = records.map((record, index) => {
      if (!record || record.kind !== "found") {
        throw new Error(`Task ${taskIds[index]} referenced by a Team event could not be hydrated.`);
      }
      return record.task;
    });
    return { tasks, warnings: tasks.flatMap((task) => task.projection_warnings ?? []) };
  }

  private mergeTaskProjection(base: TaskProjection, refreshed: TaskProjection): TaskProjection {
    const byId = new Map(base.tasks.map((task) => [task.id, task]));
    for (const task of refreshed.tasks) byId.set(task.id, task);
    const warnings = [...byId.values()].flatMap((task) => task.projection_warnings ?? []);
    return { tasks: [...byId.values()], warnings };
  }

  private changedTaskIds(before: TaskProjection, after: TaskProjection): string[] {
    const beforeById = new Map(before.tasks.map((task) => [task.id, JSON.stringify(task)]));
    return after.tasks
      .filter((task) => beforeById.get(task.id) !== JSON.stringify(task))
      .map((task) => task.id);
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

  private async workerRunObservations(bound: BoundTeam): Promise<WorkerRunObservation[]> {
    const workers = bound.config.logicalWorkers ?? [];
    return Promise.all(workers.map(async (worker) => {
      const member = currentMember(bound.config.members, worker.name);
      return member ? readWorkerRunObservation(bound.teamName, member) : { worker: worker.name, state: "absent" as const, actuationPending: false };
    }));
  }

  private async projectUpdates(bound: BoundTeam, events: TeamEvent[], observation: HiddenObservationProjection, taskProjection?: TaskCard[], taskRevisionChanged = false, taskWarnings: TaskCardWarning[] = [], externallyChangedTaskIds: readonly string[] = []): Promise<Extract<TeamSyncPortResult, { kind: "updates" }> | Extract<TeamSyncPortResult, { kind: "contract_gap" }>> {
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
    const changes = [...taskChanges.changes];
    const changedByEvent = new Set(changes.map((change) => change.taskId));
    for (const taskId of externallyChangedTaskIds) {
      if (changedByEvent.has(taskId)) continue;
      const current = taskResult.tasks.find((task) => task.id === taskId);
      if (!current) continue;
      changes.push({ taskId, changeKinds: ["progress"], journalEntries: [], current });
    }
    const result: Extract<TeamSyncPortResult, { kind: "updates" }> = {
      kind: "updates",
      teamChanges: [],
      workerChanges,
      taskChanges: changes,
      alerts: [],
      head: events.length === 0 ? asNumber(observation.teamEventCursor) : Math.max(...events.map((event) => asNumber(event.cursor))),
      epochId: bound.config.epochId!,
      ...(taskResult.warnings.length ? { taskProjectionWarnings: taskResult.warnings } : {}),
    };
    return result;
  }

  private stage(leaderSessionId: ExactLeaderSessionId, exactSessionFile: string, toolCallId: string, result: TeamSyncPortResult, head: number, epochId: string, teamName: string, view: "snapshot" | "updates", authorityRevisions: Record<string, string> = { team_events: String(head) }, taskProjection?: TaskProjection): void {
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
      ...(taskProjection ? { taskProjection: structuredClone(taskProjection) } : {}),
    });
  }
}

export function durableModelToolLeaderSessionId(value: string): ExactLeaderSessionId {
  return exactLeaderSessionId(value);
}
