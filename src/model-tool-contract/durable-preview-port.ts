import { getTerminalAdapter } from "../adapters/terminal-registry";
import crypto from "node:crypto";
import * as paths from "../utils/paths";
import * as teams from "../utils/teams";
import * as tasks from "../utils/tasks";
import * as teamEvents from "../utils/team-events";
import { BeadsError } from "../utils/beads";
import * as alerts from "../utils/alerts";
import { resolveWorkerLaunchResources } from "../utils/worker-resource-projection";
import { createWorkerLaunchBridge, type WorkerLaunchBridge } from "../utils/worker-launch-bridge";
import { MODEL_TOOL_IMPLEMENTATION_VERSION, MODEL_TOOL_PREVIEW_WORKER_MARKER } from "./preview-constants";
import { taskVersionRef } from "./task-version-ref";
import {
  CandidateBeadsTaskAdapter,
  projectCandidateNonterminalTaskIds,
  projectCandidateTaskChanges,
  type CandidateTaskChangeProjection,
} from "./beads-task-adapter";
import {
  commitHiddenObservationProjection,
  readHiddenObservationProjection,
  type HiddenObservationProjection,
} from "../utils/hidden-observation";
import type {
  ExactLeaderSessionId,
  ModelToolTaskCurrent,
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
import type { Member, TeamConfig, TeamEvent } from "../utils/models";
import { exactLeaderSessionId } from "./in-memory-team-port";
import type { TaskFile } from "../utils/models";

const WAIT_MS = 120_000;

type PendingDurableObservation = PendingObservation & {
  internalResult: TeamSyncPortResult;
  teamName: string;
  view: "snapshot" | "updates";
  authorityRevisions: Record<string, string>;
};

type BoundTeam = { teamName: string; config: TeamConfig; sessionFile: string };

export interface DurablePreviewLifecycle {
  teamCreated?(teamName: string, sessionFile: string): Promise<void>;
  stopWorker(teamName: string, worker: string): Promise<WorkerStopPortResult>;
  shutdownTeam(teamName: string): Promise<TeamShutdownPortResult>;
}

function taskProjectionRevision(tasks: readonly ModelToolTaskCurrent[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(tasks)).digest("hex");
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

function isMissingTask(error: unknown): boolean {
  if (error instanceof BeadsError) return /not found|missing|does not exist/i.test(error.message);
  return error instanceof Error && /not found|missing|does not exist/i.test(error.message);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function currentTaskProjection(task: TaskFile, candidate: ModelToolTaskCurrent): ModelToolTaskCurrent {
  return {
    ...candidate,
    status: task.status,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    version: task.version,
  };
}

function workerEventChange(event: Extract<TeamEvent, { type: "worker" }>): "created" | "connected" | "stopped" | "failed" {
  if (event.phase === "prepared") return "created";
  if (event.phase === "session_bound") return "connected";
  return event.phase;
}

/**
 * Durable preview adapter. It projects existing Team, Beads, event, and
 * Membership authorities; it owns no Team, Task, Worker, or event store.
 */
export class DurablePreviewTeamPort implements ModelToolTeamPort {
  private readonly sessionFiles = new Map<ExactLeaderSessionId, string>();
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
    workerAggregate: (cwd) => {
      const resources = resolveWorkerLaunchResources({
        cwd,
        leaderCwd: process.cwd(),
        leaderProjectTrusted: false,
      });
      return { path: resources.aggregatePath, projectTrusted: resources.projectTrusted };
    },
  });
  private readonly launchBridge: WorkerLaunchBridge;
  private readonly lifecycle?: DurablePreviewLifecycle;

  constructor(launchBridge?: WorkerLaunchBridge, lifecycle?: DurablePreviewLifecycle) {
    this.launchBridge = launchBridge ?? this.defaultLaunchBridge;
    this.lifecycle = lifecycle;
  }

  setLeaderSessionFile(leaderSessionId: ExactLeaderSessionId, sessionFile: string): void {
    this.sessionFiles.set(leaderSessionId, sessionFile);
  }

  async createTeam(
    leaderSessionId: ExactLeaderSessionId,
    input: { name: string; purpose: string },
  ): Promise<CreateTeamPortResult> {
    const sessionFile = this.sessionFiles.get(leaderSessionId);
    if (!sessionFile) return { kind: "unavailable", reason: "session_binding_unavailable", message: "The preview requires the exact durable leader Session file." };
    const existing = await teams.resolveCurrentLeadSessionBinding(sessionFile);
    if (existing.status === "bound") return { kind: "refused", reason: "active_team_exists" };
    if (existing.status !== "abstain" || existing.reason === "runtime_metadata_unavailable") {
      return { kind: "unavailable", reason: "session_binding_unavailable", message: "The exact leader Session binding is not uniquely available." };
    }
    const teamName = paths.sanitizeName(input.name);
    const terminal = getTerminalAdapter();
    if (!terminal) return { kind: "unavailable", reason: "carrier_unavailable", message: "No supported terminal carrier is available for the preview Worker." };
    let authority;
    try {
      authority = await tasks.resolveTeamTaskAuthority(teamName);
    } catch (error) {
      return { kind: "unavailable", reason: "task_authority_unavailable", message: error instanceof Error ? error.message : String(error) };
    }
    try {
      const config = await teams.withTeamTopologyLease(teamName, (lease) => teams.createTeam(
        teamName,
        sessionFile,
        "lead-agent",
        input.purpose,
        process.env.PI_MODEL_TOOL_PREVIEW_WORKER_MODEL,
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
    let launch;
    try {
      launch = await this.launchBridge.ensureWorker({
        teamName: bound.teamName,
        workerName: input.name,
        scope: logical.worker.scope,
        cwd: process.cwd(),
        launchEnvironment: { [MODEL_TOOL_PREVIEW_WORKER_MARKER]: "1" },
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
    const gap = teams.teamPreviewContractGap(bound.config);
    if (gap) return { ...gap, message: `Preview ${gap.reason.replaceAll("_", " ")} is unavailable for Team ${bound.teamName}.` };
    try {
      const tasks = await this.readCandidateTasks(bound.teamName);
      if (tasks.kind === "contract_gap") return tasks;
      const workers = this.readWorkers(bound, tasks.tasks);
      return { kind: "snapshot", team: currentTeam(bound.config), workers, tasks: tasks.tasks };
    } catch (error) {
      return { kind: "contract_gap", reason: "structured_task_event_evidence_absent", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async createTask(
    leaderSessionId: ExactLeaderSessionId,
    input: { title: string; goal: string; assignee?: string },
  ): Promise<CreateTaskPortResult> {
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "no_active_team" };
    if (input.assignee) {
      const logical = await teams.readLogicalWorker(bound.teamName, input.assignee);
      if (logical.kind !== "found") return { kind: "worker_unavailable" };
    }
    try {
      const receipt = await new CandidateBeadsTaskAdapter(bound.teamName, "team-lead").createWithReceipt(input);
      return { kind: "created", task: receipt.task, ...(receipt.deliveryWarnings.length > 0 ? { deliveryWarnings: receipt.deliveryWarnings } : {}) };
    } catch (error) {
      return { kind: "unavailable", reason: "task_authority_unavailable", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async readTasks(leaderSessionId: ExactLeaderSessionId, taskIds: string[]): Promise<ReadTasksPortResult> {
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "no_active_team" };
    const adapter = new CandidateBeadsTaskAdapter(bound.teamName, "team-lead");
    const results: Array<ModelToolTaskCurrent | undefined | ReadTaskContractGap> = [];
    for (const taskId of taskIds) {
      try {
        const result = await adapter.read(taskId);
        results.push(result.kind === "found" ? result.task : result);
      } catch (error) {
        if (isMissingTask(error)) results.push(undefined);
        else throw error;
      }
    }
    return { kind: "read", tasks: results };
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
    const adapter = new CandidateBeadsTaskAdapter(bound.teamName, "team-lead");
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
          unsupported: ["candidate_metadata"],
        });
      }
    }
    return { kind: "batch", outcomes };
  }

  async stopWorker(leaderSessionId: ExactLeaderSessionId, worker: string): Promise<WorkerStopPortResult> {
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    if (!this.lifecycle) return { kind: "unavailable", reason: "carrier_unavailable", message: "The preview lifecycle adapter is not attached to the main extension." };
    return this.lifecycle.stopWorker(bound.teamName, worker);
  }

  async shutdownTeam(leaderSessionId: ExactLeaderSessionId): Promise<TeamShutdownPortResult> {
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    if (!this.lifecycle) return { kind: "unavailable", reason: "team_authority_unavailable", message: "The preview lifecycle adapter is not attached to the main extension." };
    return this.lifecycle.shutdownTeam(bound.teamName);
  }

  async linkTask(leaderSessionId: ExactLeaderSessionId, input: TaskLinkPortInput): Promise<TaskLinkPortResult> {
    const bound = await this.boundTeam(leaderSessionId);
    if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    const lead = [...bound.config.members].reverse().find((member) => member.name === "team-lead" && member.isActive !== false);
    try {
      const current = await tasks.readTask(bound.teamName, input.taskId);
      if (input.expectedVersion && taskVersionRef(current.version) !== input.expectedVersion) {
        return { kind: "refused", taskId: input.taskId, reason: "version_conflict", message: "The supplied Task version ref is stale; read the current Task before retrying." };
      }
      const result = await tasks.mutateTaskLink(bound.teamName, input.taskId, {
        relation: input.relation,
        targetId: input.targetId,
        action: input.action,
      }, {
        actor: "team-lead",
        expectedVersion: input.expectedVersion ? current.version : undefined,
        actingSessionFile: bound.sessionFile,
        actingMembershipId: lead?.membershipId,
      });
      return { kind: "linked", taskId: input.taskId, targetId: input.targetId, relation: input.relation, action: input.action, changed: result.changed, version: result.task.version };
    } catch (error) {
      if (error instanceof BeadsError) {
        const message = error.message;
        const reason = /not found|no issue found/i.test(message)
          ? "task_not_found" as const
          : /changed since version|expected(?: Task)? version|stale/i.test(message)
            ? "version_conflict" as const
            : "graph_conflict" as const;
        return { kind: "refused", taskId: input.taskId, reason, message };
      }
      return { kind: "unavailable", reason: "task_authority_unavailable", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async sendAlert(leaderSessionId: ExactLeaderSessionId, input: { target: import("./in-memory-team-port").AlertTarget; kind: "clarification" | "attention" | "announcement"; text: string; taskId?: string; taskVersion?: string }): Promise<AlertSendPortResult> {
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
    const gap = teams.teamPreviewContractGap(bound.config);
    if (gap) return { kind: "contract_gap", reason: gap.reason, message: `Preview ${gap.reason.replaceAll("_", " ")} is unavailable for Team ${bound.teamName}.` };
    const pending = this.pending.get(leaderSessionId);
    if (pending) return pending.internalResult;
    const branchLineage = this.branchIds.get(leaderSessionId) ?? [];
    if (view === "updates") {
      const observation = await readHiddenObservationProjection(bound.teamName, {
        teamEpochId: bound.config.epochId!,
        exactSessionId: bound.sessionFile,
        branchLineage,
      });
      if (observation.kind === "contract_gap") return { ...observation, message: `Preview ${observation.reason.replaceAll("_", " ")} is unavailable for Team ${bound.teamName}.` };
      if (observation.kind !== "found") {
        return { kind: "snapshot_required", message: "Take a Team snapshot before requesting updates." };
      }
      let tasksResult = await this.readCandidateTasks(bound.teamName);
      if (tasksResult.kind === "contract_gap") return tasksResult;
      let batch = teamEvents.readTeamEvents(bound.teamName, { afterCursor: observation.projection.teamEventCursor });
      const taskRevisionChanged = observation.projection.authorityRevisions.task_projection !== taskProjectionRevision(tasksResult.tasks);
      if (batch.events.length === 0 && !taskRevisionChanged) {
        try {
          const waited = await teamEvents.waitForTeamEvents({ teamName: bound.teamName, afterCursor: observation.projection.teamEventCursor, waitMs: WAIT_MS, signal });
          batch = waited;
          tasksResult = await this.readCandidateTasks(bound.teamName);
          if (tasksResult.kind === "contract_gap") return tasksResult;
        } catch (error) {
          if (isAbort(error)) return { kind: "cancelled", message: "The updates wait was cancelled before an observation was published." };
          throw error;
        }
      }
      const result = await this.projectUpdates(bound, batch.events, observation.projection, tasksResult.tasks, taskRevisionChanged);
      if (result.kind === "contract_gap") return result;
      this.stage(leaderSessionId, bound.sessionFile, toolCallId, result, asNumber(batch.headCursor), bound.config.epochId!, bound.teamName, view, {
        team_events: String(asNumber(batch.headCursor)),
        task_projection: taskProjectionRevision(tasksResult.tasks),
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
      task_projection: taskProjectionRevision(result.tasks),
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
    // The candidate surface must never mutate a Team created by another
    // implementation epoch. Legacy records remain readable by the legacy
    // surface, but this port fails closed before any candidate mutation.
    if (config.implementationVersion !== MODEL_TOOL_IMPLEMENTATION_VERSION) return undefined;
    return { teamName: binding.teamName, config, sessionFile };
  }

  private async readCandidateTasks(teamName: string): Promise<{ kind: "tasks"; tasks: ModelToolTaskCurrent[] } | Extract<TeamSyncPortResult, { kind: "contract_gap" }>> {
    const listed = await tasks.listTasksWithVersions(teamName);
    const adapter = new CandidateBeadsTaskAdapter(teamName, "team-lead");
    const projected: ModelToolTaskCurrent[] = [];
    for (const task of listed) {
      const result = await adapter.read(task.id);
      if (result.kind === "contract_gap") return result;
      projected.push(currentTaskProjection(task, result.task));
    }
    return { kind: "tasks", tasks: projected };
  }

  private readWorkers(bound: BoundTeam, taskProjection: ModelToolTaskCurrent[]): Array<ModelToolWorkerCurrent & { nonterminalTaskIds: string[] }> {
    return (bound.config.logicalWorkers ?? []).map((logical) => {
      const member = latestMember(bound.config, logical.name);
      return {
        name: logical.name,
        scope: logical.scope,
        carrier: workerCarrier(member),
        nonterminalTaskIds: projectCandidateNonterminalTaskIds(taskProjection, logical.name),
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
  }

  private async projectUpdates(bound: BoundTeam, events: TeamEvent[], observation: HiddenObservationProjection, taskProjection?: ModelToolTaskCurrent[], taskRevisionChanged = false): Promise<Extract<TeamSyncPortResult, { kind: "updates" }> | Extract<TeamSyncPortResult, { kind: "contract_gap" }>> {
    const taskResult = taskProjection ? { kind: "tasks" as const, tasks: taskProjection } : await this.readCandidateTasks(bound.teamName);
    if (taskResult.kind !== "tasks") return taskResult;
    const workerChanges: Array<{ worker: string; scope: string; kind: "created" | "connected" | "stopped" | "failed" | "scope_changed"; text: string }> = [];
    for (const event of events) {
      if (event.type !== "worker") continue;
      const logical = bound.config.logicalWorkers?.find((worker) => worker.name === event.worker);
      if (!logical) continue;
      workerChanges.push({ worker: logical.name, scope: logical.scope, kind: workerEventChange(event), text: `Worker ${logical.name} ${event.phase.replaceAll("_", " ")}.` });
    }
    const taskChanges = events.length > 0
      ? projectCandidateTaskChanges(events, taskResult.tasks)
      : { kind: "projected" as const, changes: taskRevisionChanged ? taskResult.tasks.map((task) => ({
        taskId: task.id,
        changeKinds: ["progress" as const],
        journalEntries: [],
        current: {
          status: task.status,
          ...(task.assignee ? { assignee: task.assignee } : {}),
          current_context: task.current_context,
          version: task.version,
        },
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

export function durablePreviewLeaderSessionId(value: string): ExactLeaderSessionId {
  return exactLeaderSessionId(value);
}
