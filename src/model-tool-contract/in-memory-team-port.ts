import { createHash } from "node:crypto";
import { taskVersionRef } from "./task-version-ref";
import type { TeamPaneLayout } from "../utils/team-pane-layout";

declare const exactLeaderSessionIdBrand: unique symbol;

/** Exact Pi Session identity. It is not a Session file, process, pane, or agent name. */
export type ExactLeaderSessionId = string & {
  readonly [exactLeaderSessionIdBrand]: "ExactLeaderSessionId";
};

export function exactLeaderSessionId(value: string): ExactLeaderSessionId {
  if (value.length === 0) throw new Error("Exact leader Session identity must not be empty.");
  return value as ExactLeaderSessionId;
}

export interface ModelToolTeamCurrent {
  name: string;
  purpose: string;
  lifecycle: "active";
}

export interface ModelToolWorkerCurrent {
  name: string;
  scope: string;
  carrier: "starting" | "connected" | "absent";
}

export type ModelToolTaskProjectionField = "title" | "goal" | "current_context";

/** Explicit evidence when an external authority record cannot fit the model projection. */
export interface ModelToolTaskProjectionWarning {
  task_id: string;
  truncated_fields: ModelToolTaskProjectionField[];
  incomplete_fields: ModelToolTaskProjectionField[];
  message: string;
}

interface ModelToolTaskCurrentBase {
  id: string;
  title: string;
  status: "open" | "in_progress" | "blocked" | "closed";
  assignee?: string;
  current_context: string;
  version: string;
}

export type ModelToolTaskCurrent =
  | (ModelToolTaskCurrentBase & {
    goal: string;
    projection_warnings?: ModelToolTaskProjectionWarning[];
    goal_state?: never;
  })
  /** Incomplete cards preserve structural coordinates but cannot execute. */
  | (ModelToolTaskCurrentBase & {
    goal_state: "incomplete";
    projection_warnings: ModelToolTaskProjectionWarning[];
    goal?: never;
  });

export type CreateTeamPortResult =
  | { kind: "created"; team: ModelToolTeamCurrent }
  | { kind: "refused"; reason: "active_team_exists" | "name_unavailable" }
  | { kind: "unavailable"; reason: "team_authority_unavailable" | "session_binding_unavailable" | "task_authority_unavailable" | "carrier_unavailable"; message: string };

export type EnsureWorkerPortResult =
  | { kind: "created"; worker: ModelToolWorkerCurrent }
  | { kind: "reused"; worker: ModelToolWorkerCurrent }
  | { kind: "scope_conflict"; worker: ModelToolWorkerCurrent }
  | { kind: "unavailable"; reason: "carrier_unavailable" | "team_authority_unavailable"; message: string }
  | { kind: "no_active_team" };

export type TeamSnapshotPortResult =
  | {
    kind: "snapshot";
    team: ModelToolTeamCurrent;
    workers: Array<ModelToolWorkerCurrent & { nonterminalTaskIds: string[] }>;
    tasks: ModelToolTaskCurrent[];
    taskProjectionWarnings?: ModelToolTaskProjectionWarning[];
  }
  | { kind: "no_active_team" }
  | { kind: "contract_gap"; reason: "team_epoch_missing" | "logical_workers_missing" | "candidate_metadata_absent" | "candidate_metadata_invalid" | "structured_task_event_evidence_absent"; message: string };

export type CreateTaskPortResult =
  | { kind: "created"; operationId: string; task: ModelToolTaskCurrent; deliveryWarnings?: string[] }
  | { kind: "operation_conflict"; operationId: string; message: string }
  | { kind: "unknown_outcome"; operationId: string; message: string }
  | { kind: "worker_unavailable"; operationId: string }
  | { kind: "unavailable"; operationId: string; reason: "task_authority_unavailable"; message: string }
  | { kind: "no_active_team"; operationId: string };

export type ReadTaskContractGap = {
  kind: "contract_gap";
  reason: "candidate_metadata_absent" | "candidate_metadata_invalid";
  authorityVersion: string;
  message: string;
  projectionWarning?: ModelToolTaskProjectionWarning;
};

export type ReadTasksPortResult =
  | { kind: "read"; tasks: Array<ModelToolTaskCurrent | undefined | ReadTaskContractGap> }
  | { kind: "no_active_team" };

export interface ModelToolTaskUpdateInput {
  taskId: string;
  operationId: string;
  expectedVersion: string;
  currentContext?: string;
  journalEntries?: Array<{ kind: "progress" | "decision" | "blocker" | "result" | "note"; text: string }>;
  status?: "open" | "in_progress" | "blocked" | "closed";
}

export interface ModelToolTaskJournalEntry {
  id: string;
  at: string;
  actor: string;
  kind: "progress" | "decision" | "blocker" | "result" | "note";
  text: string;
}

export type TaskUpdatePortOutcome =
  | { kind: "updated"; taskId: string; operationId: string; task: ModelToolTaskCurrent; journalEntries: ModelToolTaskJournalEntry[] }
  | { kind: "refused"; taskId: string; operationId: string; reason: "task_not_found" | "version_conflict" | "operation_conflict"; message: string; currentTask?: ModelToolTaskCurrent }
  | { kind: "contract_gap"; taskId: string; operationId: string; reason: "candidate_metadata_absent" | "candidate_metadata_invalid" | "beads_external_writer_atomicity_unavailable"; message: string; currentTask?: ModelToolTaskCurrent; unsupported: string[] }
  | { kind: "unavailable"; taskId: string; operationId: string; reason: "task_authority_unavailable"; message: string };

export type UpdateTasksPortResult =
  | { kind: "batch"; outcomes: TaskUpdatePortOutcome[] }
  | { kind: "duplicate_task_id" }
  | { kind: "no_active_team" };

export type WorkerStopPortResult =
  | { kind: "stopped"; worker: string }
  | { kind: "refused"; worker: string; reason: "worker_not_found" | "nonterminal_tasks_assigned" | "stop_not_confirmed" | "leader_reserved"; message: string; guardingTaskIds?: string[] }
  | { kind: "unavailable"; reason: "no_active_team" | "team_authority_unavailable" | "carrier_unavailable"; message: string };

export type TeamShutdownPortResult =
  | { kind: "shutdown"; stoppedWorkers: string[]; unfinishedTaskIds: string[] }
  | { kind: "partial"; stoppedWorkers: string[]; failedWorkers: string[]; unfinishedTaskIds: string[] }
  | { kind: "unavailable"; reason: "no_active_team" | "team_authority_unavailable"; message: string };

export interface TaskLinkPortInput {
  taskId: string;
  relation: "blocked_by" | "parent" | "related";
  targetId: string;
  action: "add" | "remove";
  expectedVersion?: string;
}

export type TaskLinkPortResult =
  | { kind: "linked"; taskId: string; targetId: string; relation: TaskLinkPortInput["relation"]; action: TaskLinkPortInput["action"]; changed: boolean; version: string }
  | { kind: "refused"; taskId: string; reason: "task_not_found" | "version_conflict" | "graph_conflict"; message: string }
  | { kind: "unavailable"; reason: "no_active_team" | "task_authority_unavailable"; message: string };

export type AlertSendPortResult =
  | { kind: "sent"; alertId: string; acceptedRecipients: string[]; failedRecipients: string[] }
  | { kind: "refused"; reason: "recipient_not_current" | "no_eligible_recipients" | "invalid_fanout"; message: string }
  | { kind: "unavailable"; reason: "no_active_team" | "team_authority_unavailable"; message: string };

export interface ModelToolTeamEvent {
  kind: "team_created" | "worker_created" | "task_created" | "task_updated";
  taskId?: string;
  workerName?: string;
  journalEntries?: ModelToolTaskJournalEntry[];
  statusChanged?: boolean;
}

export type TeamSyncPortResult =
  | { kind: "snapshot"; team: ModelToolTeamCurrent; workers: Array<ModelToolWorkerCurrent & { nonterminalTaskIds: string[] }>; tasks: ModelToolTaskCurrent[]; taskProjectionWarnings?: ModelToolTaskProjectionWarning[]; head: number; epochId: string }
  | { kind: "updates"; teamChanges: Array<{ kind: "created" | "lifecycle" | "purpose"; text: string }>; workerChanges: Array<{ worker: string; scope: string; kind: "created" | "connected" | "stopped" | "failed" | "scope_changed"; text: string }>; taskChanges: Array<{ taskId: string; changeKinds: Array<"created" | "goal" | "assignment" | "progress" | "status" | "relation">; journalEntries: ModelToolTaskJournalEntry[]; current: { status: ModelToolTaskCurrent["status"]; assignee?: string; current_context: string; version: string } }>; taskProjectionWarnings?: ModelToolTaskProjectionWarning[]; alerts: []; head: number; epochId: string }
  | { kind: "snapshot_required"; message: string }
  | { kind: "cancelled"; message: string }
  | { kind: "contract_gap"; reason: "team_epoch_missing" | "logical_workers_missing" | "candidate_metadata_absent" | "candidate_metadata_invalid" | "structured_task_event_evidence_absent"; message: string }
  | { kind: "unavailable"; reason: "no_active_team" | "team_state_unavailable" | "task_authority_unavailable"; message: string };

export interface PendingObservation {
  sessionId: string;
  toolCallId: string;
  resultText: string;
  resultDigest: string;
  head: number;
  epochId: string;
}

export type AlertTarget =
  | { kind: "worker"; name: string }
  | { kind: "team" };

export interface ModelToolLeaderLaunchContext {
  /** Exact leader cwd used for Worker launch trust resolution. */
  cwd: string;
  /** Resolved Pi trust, or undefined when the ExtensionContext lacks it. */
  projectTrusted?: boolean;
}

export interface ModelToolTeamPort {
  createTeam(
    leaderSessionId: ExactLeaderSessionId,
    input: { name: string; purpose: string; pane_layout?: TeamPaneLayout },
  ): Promise<CreateTeamPortResult>;
  ensureWorker(
    leaderSessionId: ExactLeaderSessionId,
    input: { name: string; scope: string },
  ): Promise<EnsureWorkerPortResult>;
  readSnapshot(leaderSessionId: ExactLeaderSessionId): Promise<TeamSnapshotPortResult>;
  createTask(
    leaderSessionId: ExactLeaderSessionId,
    input: { operationId: string; title: string; goal: string; assignee?: string },
  ): Promise<CreateTaskPortResult>;
  readTasks(
    leaderSessionId: ExactLeaderSessionId,
    taskIds: string[],
  ): Promise<ReadTasksPortResult>;
  updateTasks(
    leaderSessionId: ExactLeaderSessionId,
    updates: ModelToolTaskUpdateInput[],
  ): Promise<UpdateTasksPortResult>;
  stopWorker(leaderSessionId: ExactLeaderSessionId, worker: string): Promise<WorkerStopPortResult>;
  shutdownTeam(leaderSessionId: ExactLeaderSessionId): Promise<TeamShutdownPortResult>;
  linkTask(leaderSessionId: ExactLeaderSessionId, input: TaskLinkPortInput): Promise<TaskLinkPortResult>;
  sendAlert(leaderSessionId: ExactLeaderSessionId, input: { target: AlertTarget; kind: "clarification" | "attention" | "announcement"; text: string; taskId?: string; taskVersion?: string }): Promise<AlertSendPortResult>;
  readTeamSync(
    leaderSessionId: ExactLeaderSessionId,
    view: "snapshot" | "updates",
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<TeamSyncPortResult>;
  setPendingObservationResult(leaderSessionId: ExactLeaderSessionId, result: unknown): void;
  acknowledgePendingObservation(
    leaderSessionId: ExactLeaderSessionId,
    entryId: string,
    branchIds: string[],
  ): boolean;
  setBranchContext(leaderSessionId: ExactLeaderSessionId, branchIds: string[]): void;
  setLeaderSessionFile?(leaderSessionId: ExactLeaderSessionId, sessionFile: string): void;
  setLeaderLaunchContext?(leaderSessionId: ExactLeaderSessionId, context: ModelToolLeaderLaunchContext): void;
  acknowledgePendingObservationAsync?(leaderSessionId: ExactLeaderSessionId, entryId: string, branchIds: string[]): Promise<boolean>;
  getPendingObservation?(leaderSessionId: ExactLeaderSessionId): PendingObservation | undefined;
  readonly readDebugRevision?: () => number;
}

interface StoredTeam {
  id: string;
  leaderSessionId: ExactLeaderSessionId;
  name: string;
  purpose: string;
  lifecycle: "active";
  workersByName: Map<string, ModelToolWorkerCurrent>;
  taskIdsByWorkerName: Map<string, Set<string>>;
  tasksById: Map<string, ModelToolTaskCurrent>;
  journalEntriesByTaskId: Map<string, ModelToolTaskJournalEntry[]>;
  operationsByTaskAndId: Map<string, { taskId: string; fingerprint: string; outcome: Extract<TaskUpdatePortOutcome, { kind: "updated" }> }>;
  createOperationsById: Map<string, { fingerprint: string; taskId: string }>;
  nextJournalNumber: number;
  events: ModelToolTeamEvent[];
}

export interface InMemoryModelToolTeamDebugState {
  revision: number;
  bindings: Array<{ leaderSessionId: string; teamId: string; teamName: string }>;
  teams: Array<{
    id: string;
    name: string;
    purpose: string;
    lifecycle: "active";
    leaderSessionId: string;
    workers: ModelToolWorkerCurrent[];
  }>;
}

function currentTeam(team: StoredTeam): ModelToolTeamCurrent {
  return { name: team.name, purpose: team.purpose, lifecycle: team.lifecycle };
}

function currentWorker(worker: ModelToolWorkerCurrent): ModelToolWorkerCurrent {
  return { ...worker };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function nextTaskVersion(version: string): string {
  const number = Number(version.match(/^task_v(\d+)$/)?.[1] ?? "0");
  return `task_v${Number.isFinite(number) ? number + 1 : 1}`;
}

function operationKey(taskId: string, operationId: string): string {
  return `${taskId}\u0000${operationId}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Preliminary authority for the first model-tool journey.
 *
 * State lives only in this object. Exact leader Session identity owns the
 * binding. No process, terminal, Task, persistence, or update position exists
 * in this slice.
 */
export class InMemoryModelToolTeamPort implements ModelToolTeamPort {
  private revision = 0;
  private nextTeamNumber = 1;
  private nextTaskNumber = 1;
  private readonly activeTeamIdByLeaderSession = new Map<ExactLeaderSessionId, string>();
  private readonly teamIdByName = new Map<string, string>();
  private readonly teamsById = new Map<string, StoredTeam>();
  private readonly baselinesBySession = new Map<ExactLeaderSessionId, { head: number; entryId: string; epochId: string }>();
  private readonly pendingObservationsBySession = new Map<ExactLeaderSessionId, PendingObservation & { internalResult: TeamSyncPortResult; semanticResult?: unknown }>();
  private readonly branchIdsBySession = new Map<ExactLeaderSessionId, string[]>();
  private readonly waiters = new Set<{ sessionId: ExactLeaderSessionId; toolCallId: string; resolve: (result: TeamSyncPortResult) => void; signal: AbortSignal; onAbort: () => void }>();

  async createTeam(
    leaderSessionId: ExactLeaderSessionId,
    input: { name: string; purpose: string; pane_layout?: TeamPaneLayout },
  ): Promise<CreateTeamPortResult> {
    if (this.activeTeamIdByLeaderSession.has(leaderSessionId)) {
      return { kind: "refused", reason: "active_team_exists" };
    }
    if (this.teamIdByName.has(input.name)) {
      return { kind: "refused", reason: "name_unavailable" };
    }

    const team: StoredTeam = {
      id: `in-memory-team-${this.nextTeamNumber}`,
      leaderSessionId,
      name: input.name,
      purpose: input.purpose,
      lifecycle: "active",
      workersByName: new Map(),
      taskIdsByWorkerName: new Map(),
      tasksById: new Map(),
      journalEntriesByTaskId: new Map(),
      operationsByTaskAndId: new Map(),
      createOperationsById: new Map(),
      nextJournalNumber: 1,
      events: [],
    };

    // These synchronous writes are one in-memory create-and-bind operation. No
    // executor can observe a Team record without both indexes and its binding.
    this.teamsById.set(team.id, team);
    this.teamIdByName.set(team.name, team.id);
    this.activeTeamIdByLeaderSession.set(leaderSessionId, team.id);
    team.events.push({ kind: "team_created" });
    this.nextTeamNumber += 1;
    this.revision += 1;
    return { kind: "created", team: currentTeam(team) };
  }

  async ensureWorker(
    leaderSessionId: ExactLeaderSessionId,
    input: { name: string; scope: string },
  ): Promise<EnsureWorkerPortResult> {
    const team = this.activeTeamFor(leaderSessionId);
    if (!team) return { kind: "no_active_team" };

    const existing = team.workersByName.get(input.name);
    if (existing) {
      if (existing.scope !== input.scope) {
        return { kind: "scope_conflict", worker: currentWorker(existing) };
      }
      return { kind: "reused", worker: currentWorker(existing) };
    }

    // There is no real carrier in this slice. The logical Worker is observable,
    // but its carrier remains explicitly absent.
    const worker: ModelToolWorkerCurrent = {
      name: input.name,
      scope: input.scope,
      carrier: "absent",
    };
    team.workersByName.set(worker.name, worker);
    team.events.push({ kind: "worker_created", workerName: worker.name });
    this.revision += 1;
    this.notifyWaiters(leaderSessionId);
    return { kind: "created", worker: currentWorker(worker) };
  }

  async createTask(
    leaderSessionId: ExactLeaderSessionId,
    input: { operationId: string; title: string; goal: string; assignee?: string },
  ): Promise<CreateTaskPortResult> {
    const team = this.activeTeamFor(leaderSessionId);
    if (!team) return { kind: "no_active_team", operationId: input.operationId };
    const fingerprint = JSON.stringify({ title: input.title, goal: input.goal, ...(input.assignee ? { assignee: input.assignee } : {}) });
    const previous = team.createOperationsById.get(input.operationId);
    if (previous) {
      const task = team.tasksById.get(previous.taskId);
      if (previous.fingerprint !== fingerprint || !task) {
        return { kind: "operation_conflict", operationId: input.operationId, message: "The create operation ID was already used with different input." };
      }
      return { kind: "created", operationId: input.operationId, task: { ...task } };
    }
    if (input.assignee && !team.workersByName.has(input.assignee)) {
      return { kind: "worker_unavailable", operationId: input.operationId };
    }

    const task: ModelToolTaskCurrent = {
      id: `task-${this.nextTaskNumber}`,
      title: input.title,
      goal: input.goal,
      status: "open",
      ...(input.assignee ? { assignee: input.assignee } : {}),
      current_context: "Work has not started.",
      version: "task_v1",
    };
    const taskIds = input.assignee
      ? team.taskIdsByWorkerName.get(input.assignee) ?? new Set<string>()
      : undefined;
    // These synchronous writes commit one item and its Worker index together.
    team.tasksById.set(task.id, task);
    team.createOperationsById.set(input.operationId, { fingerprint, taskId: task.id });
    if (taskIds && input.assignee && task.status !== "closed") {
      taskIds.add(task.id);
      team.taskIdsByWorkerName.set(input.assignee, taskIds);
    }
    team.events.push({ kind: "task_created", taskId: task.id });
    this.nextTaskNumber += 1;
    this.revision += 1;
    this.notifyWaiters(leaderSessionId);
    return { kind: "created", operationId: input.operationId, task: { ...task } };
  }

  async updateTasks(
    leaderSessionId: ExactLeaderSessionId,
    updates: ModelToolTaskUpdateInput[],
  ): Promise<UpdateTasksPortResult> {
    const duplicateIds = new Set<string>();
    const seenIds = new Set<string>();
    for (const update of updates) {
      if (seenIds.has(update.taskId)) duplicateIds.add(update.taskId);
      seenIds.add(update.taskId);
    }
    if (duplicateIds.size > 0) return { kind: "duplicate_task_id" };

    const team = this.activeTeamFor(leaderSessionId);
    if (!team) return { kind: "no_active_team" };

    const outcomes: TaskUpdatePortOutcome[] = [];
    for (const input of updates) {
      const task = team.tasksById.get(input.taskId);
      const currentTask = task ? { ...task } : undefined;
      const fingerprint = JSON.stringify(canonical(input));
      const prior = team.operationsByTaskAndId.get(operationKey(input.taskId, input.operationId));
      if (prior) {
        if (prior.fingerprint === fingerprint) {
          outcomes.push({
            ...prior.outcome,
            task: { ...prior.outcome.task },
            journalEntries: prior.outcome.journalEntries.map((entry) => ({ ...entry })),
          });
        } else {
          outcomes.push({
            kind: "refused",
            taskId: input.taskId,
            operationId: input.operationId,
            reason: "operation_conflict",
            message: "The operation ID was already used with different input.",
            ...(currentTask ? { currentTask } : {}),
          });
        }
        continue;
      }
      if (!task) {
        outcomes.push({
          kind: "refused",
          taskId: input.taskId,
          operationId: input.operationId,
          reason: "task_not_found",
          message: "The Task does not exist in the exact active Team.",
        });
        continue;
      }
      if (taskVersionRef(task.version) !== input.expectedVersion) {
        outcomes.push({
          kind: "refused",
          taskId: input.taskId,
          operationId: input.operationId,
          reason: "version_conflict",
          message: `Expected Task version ${input.expectedVersion}, but current version is ${task.version}.`,
          currentTask,
        });
        continue;
      }

      const updatedTask: ModelToolTaskCurrent = {
        ...task,
        ...(input.currentContext !== undefined ? { current_context: input.currentContext } : {}),
        ...(input.status ? { status: input.status } : {}),
        version: nextTaskVersion(task.version),
      };
      const journalEntries = (input.journalEntries ?? []).map((entry) => ({
        id: `journal-${input.taskId}-${team.nextJournalNumber++}`,
        at: new Date().toISOString(),
        actor: "leader" as const,
        kind: entry.kind,
        text: entry.text,
      }));
      // These writes commit current state, journal provenance, operation receipt, and Worker index together.
      team.tasksById.set(input.taskId, updatedTask);
      const workerTaskIds = updatedTask.assignee
        ? team.taskIdsByWorkerName.get(updatedTask.assignee) ?? new Set<string>()
        : undefined;
      if (workerTaskIds && updatedTask.assignee) {
        if (updatedTask.status === "closed") workerTaskIds.delete(input.taskId);
        else workerTaskIds.add(input.taskId);
        team.taskIdsByWorkerName.set(updatedTask.assignee, workerTaskIds);
      }
      team.journalEntriesByTaskId.set(input.taskId, [
        ...(team.journalEntriesByTaskId.get(input.taskId) ?? []),
        ...journalEntries,
      ]);
      const outcome = { kind: "updated" as const, taskId: input.taskId, operationId: input.operationId, task: { ...updatedTask }, journalEntries: journalEntries.map((entry) => ({ ...entry })) };
      team.operationsByTaskAndId.set(operationKey(input.taskId, input.operationId), { taskId: input.taskId, fingerprint, outcome });
      team.events.push({
        kind: "task_updated",
        taskId: input.taskId,
        journalEntries: journalEntries.map((entry) => ({ ...entry })),
        statusChanged: task.status !== updatedTask.status,
      });
      this.revision += 1;
      this.notifyWaiters(leaderSessionId);
      outcomes.push({ ...outcome, task: { ...outcome.task }, journalEntries: outcome.journalEntries.map((entry) => ({ ...entry })) });
    }
    return { kind: "batch", outcomes };
  }

  async stopWorker(leaderSessionId: ExactLeaderSessionId, worker: string): Promise<WorkerStopPortResult> {
    const team = this.activeTeamFor(leaderSessionId);
    if (!team) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    if (worker === "team-lead") return { kind: "refused", worker, reason: "leader_reserved", message: "The Team leader is reserved; use team_shutdown for whole-Team closure." };
    const current = team.workersByName.get(worker);
    if (!current) return { kind: "refused", worker, reason: "worker_not_found", message: `Worker ${worker} is not current.` };
    const guardingTaskIds = [...(team.taskIdsByWorkerName.get(worker) ?? [])].filter((id) => team.tasksById.get(id)?.status !== "closed");
    if (guardingTaskIds.length > 0) return { kind: "refused", worker, reason: "nonterminal_tasks_assigned", message: "Worker has nonterminal Tasks.", guardingTaskIds };
    team.workersByName.delete(worker);
    team.taskIdsByWorkerName.delete(worker);
    this.revision += 1;
    return { kind: "stopped", worker };
  }

  async shutdownTeam(leaderSessionId: ExactLeaderSessionId): Promise<TeamShutdownPortResult> {
    const team = this.activeTeamFor(leaderSessionId);
    if (!team) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    const unfinishedTaskIds = [...team.tasksById.values()].filter((task) => task.status !== "closed").map((task) => task.id);
    const stoppedWorkers = [...team.workersByName.keys()];
    team.workersByName.clear();
    team.taskIdsByWorkerName.clear();
    team.lifecycle = "active";
    this.revision += 1;
    return { kind: "shutdown", stoppedWorkers, unfinishedTaskIds };
  }

  async linkTask(_leaderSessionId: ExactLeaderSessionId, input: TaskLinkPortInput): Promise<TaskLinkPortResult> {
    return { kind: "unavailable", reason: "task_authority_unavailable", message: `The in-memory model-tool port has no relation authority for ${input.taskId}.` };
  }

  async sendAlert(leaderSessionId: ExactLeaderSessionId, input: { target: AlertTarget; kind: "clarification" | "attention" | "announcement"; text: string; taskId?: string; taskVersion?: string }): Promise<AlertSendPortResult> {
    const team = this.activeTeamFor(leaderSessionId);
    if (!team) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    if (input.target.kind === "team" && input.kind !== "announcement") return { kind: "refused", reason: "invalid_fanout", message: "Only announcement Alerts may target the whole Team." };
    const recipients = input.target.kind === "team" ? [...team.workersByName.keys()] : [input.target.name];
    const acceptedRecipients = recipients.filter((recipient) => team.workersByName.has(recipient));
    if (acceptedRecipients.length === 0) return { kind: "refused", reason: input.target.kind === "team" ? "no_eligible_recipients" : "recipient_not_current", message: "No current recipient accepted the Alert." };
    return { kind: "sent", alertId: `alert-${this.revision + 1}`, acceptedRecipients, failedRecipients: [] };
  }

  async readTeamSync(
    leaderSessionId: ExactLeaderSessionId,
    view: "snapshot" | "updates",
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<TeamSyncPortResult> {
    const team = this.activeTeamFor(leaderSessionId);
    if (!team) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    const pending = this.pendingObservationsBySession.get(leaderSessionId);
    if (pending) return this.pendingResult(pending);

    const branchIds = this.branchIdsBySession.get(leaderSessionId) ?? [];
    const baseline = this.baselinesBySession.get(leaderSessionId);
    if (baseline && (!branchIds.includes(baseline.entryId) || baseline.epochId !== team.id)) {
      this.baselinesBySession.delete(leaderSessionId);
    }
    const currentBaseline = this.baselinesBySession.get(leaderSessionId);
    if (view === "updates" && !currentBaseline) {
      return { kind: "snapshot_required", message: "Take a Team snapshot before requesting updates." };
    }

    if (view === "updates" && currentBaseline && team.events.length <= currentBaseline.head) {
      return this.waitForTeamChange(leaderSessionId, team, signal, toolCallId);
    }

    const result = view === "snapshot"
      ? this.snapshotPortResult(team)
      : this.updatesPortResult(team, currentBaseline?.head ?? 0);
    this.stageObservation(leaderSessionId, toolCallId, result, team.events.length, team.id);
    return result;
  }

  setPendingObservationResult(leaderSessionId: ExactLeaderSessionId, result: unknown): void {
    const pending = this.pendingObservationsBySession.get(leaderSessionId);
    if (!pending) return;
    const resultText = JSON.stringify(result);
    pending.semanticResult = result;
    pending.resultText = resultText;
    pending.resultDigest = digest(resultText);
  }

  acknowledgePendingObservation(
    leaderSessionId: ExactLeaderSessionId,
    entryId: string,
    branchIds: string[],
  ): boolean {
    const pending = this.pendingObservationsBySession.get(leaderSessionId);
    if (!pending || !branchIds.includes(entryId)) return false;
    const team = this.activeTeamFor(leaderSessionId);
    if (!team || team.id !== pending.epochId) return false;
    this.baselinesBySession.set(leaderSessionId, { head: pending.head, entryId, epochId: pending.epochId });
    this.pendingObservationsBySession.delete(leaderSessionId);
    return true;
  }

  setBranchContext(leaderSessionId: ExactLeaderSessionId, branchIds: string[]): void {
    this.branchIdsBySession.set(leaderSessionId, branchIds);
  }

  getPendingObservation(leaderSessionId: ExactLeaderSessionId): PendingObservation | undefined {
    const pending = this.pendingObservationsBySession.get(leaderSessionId);
    if (!pending) return undefined;
    return {
      sessionId: pending.sessionId,
      toolCallId: pending.toolCallId,
      resultText: pending.resultText,
      resultDigest: pending.resultDigest,
      head: pending.head,
      epochId: pending.epochId,
    };
  }

  private stageObservation(leaderSessionId: ExactLeaderSessionId, toolCallId: string, result: TeamSyncPortResult, head: number, epochId: string): void {
    this.pendingObservationsBySession.set(leaderSessionId, {
      sessionId: leaderSessionId,
      toolCallId,
      resultText: "",
      resultDigest: "",
      head,
      epochId,
      internalResult: result,
    });
  }

  private pendingResult(pending: PendingObservation & { internalResult: TeamSyncPortResult; semanticResult?: unknown }): TeamSyncPortResult {
    return pending.internalResult;
  }

  private snapshotPortResult(team: StoredTeam): Extract<TeamSyncPortResult, { kind: "snapshot" }> {
    return {
      kind: "snapshot",
      team: currentTeam(team),
      workers: [...team.workersByName.values()].map((worker) => ({
        ...currentWorker(worker),
        nonterminalTaskIds: [...(team.taskIdsByWorkerName.get(worker.name) ?? [])].sort(),
      })).sort((left, right) => left.name.localeCompare(right.name)),
      tasks: [...team.tasksById.values()].map((task) => ({ ...task })),
      head: team.events.length,
      epochId: team.id,
    };
  }

  private updatesPortResult(team: StoredTeam, baselineHead: number): Extract<TeamSyncPortResult, { kind: "updates" }> {
    const teamChanges: Array<{ kind: "created" | "lifecycle" | "purpose"; text: string }> = [];
    const workerChanges: Array<{ worker: string; scope: string; kind: "created" | "connected" | "stopped" | "failed" | "scope_changed"; text: string }> = [];
    const taskChanges = new Map<string, { changeKinds: Array<"created" | "goal" | "assignment" | "progress" | "status" | "relation">; journalEntries: ModelToolTaskJournalEntry[] }>();
    for (const event of team.events.slice(baselineHead)) {
      if (event.kind === "team_created") teamChanges.push({ kind: "created", text: `Team ${team.name} was created.` });
      if (event.kind === "worker_created" && event.workerName) {
        const worker = team.workersByName.get(event.workerName);
        if (worker) workerChanges.push({ worker: worker.name, scope: worker.scope, kind: "created", text: `Worker ${worker.name} was created.` });
      }
      if ((event.kind === "task_created" || event.kind === "task_updated") && event.taskId) {
        const task = team.tasksById.get(event.taskId);
        if (!task) continue;
        const current = taskChanges.get(event.taskId) ?? { changeKinds: [], journalEntries: [] };
        const changeKind = event.kind === "task_created" ? "created" : "progress";
        if (!current.changeKinds.includes(changeKind)) current.changeKinds.push(changeKind);
        if (event.kind === "task_updated" && event.statusChanged && !current.changeKinds.includes("status")) {
          current.changeKinds.push("status");
        }
        if (event.journalEntries) current.journalEntries.push(...event.journalEntries.map((entry) => ({ ...entry })));
        taskChanges.set(event.taskId, current);
      }
    }
    return {
      kind: "updates",
      teamChanges,
      workerChanges,
      taskChanges: [...taskChanges].map(([taskId, change]) => {
        const task = team.tasksById.get(taskId)!;
        return {
          taskId,
          changeKinds: change.changeKinds,
          journalEntries: change.journalEntries,
          current: { status: task.status, ...(task.assignee ? { assignee: task.assignee } : {}), current_context: task.current_context, version: task.version },
        };
      }),
      alerts: [],
      head: team.events.length,
      epochId: team.id,
    };
  }

  private waitForTeamChange(leaderSessionId: ExactLeaderSessionId, team: StoredTeam, signal: AbortSignal, toolCallId: string): Promise<TeamSyncPortResult> {
    return new Promise((resolve) => {
      const onAbort = () => {
        this.waiters.delete(waiter);
        resolve({ kind: "cancelled", message: "The updates wait was cancelled before an observation was published." });
      };
      const waiter = { sessionId: leaderSessionId, toolCallId, resolve, signal, onAbort };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(waiter);
      if (team.events.length > (this.baselinesBySession.get(leaderSessionId)?.head ?? 0)) {
        this.waiters.delete(waiter);
        signal.removeEventListener("abort", onAbort);
        this.readTeamSync(leaderSessionId, "updates", signal, toolCallId).then(resolve);
      }
    });
  }

  private notifyWaiters(leaderSessionId: ExactLeaderSessionId): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.sessionId !== leaderSessionId) continue;
      this.waiters.delete(waiter);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.readTeamSync(waiter.sessionId, "updates", waiter.signal, waiter.toolCallId).then(waiter.resolve);
    }
  }

  async readTasks(
    leaderSessionId: ExactLeaderSessionId,
    taskIds: string[],
  ): Promise<ReadTasksPortResult> {
    const team = this.activeTeamFor(leaderSessionId);
    if (!team) return { kind: "no_active_team" };
    return {
      kind: "read",
      tasks: taskIds.map((taskId) => {
        const task = team.tasksById.get(taskId);
        return task ? { ...task } : undefined;
      }),
    };
  }

  readDebugRevision(): number {
    return this.revision;
  }

  async readSnapshot(leaderSessionId: ExactLeaderSessionId): Promise<TeamSnapshotPortResult> {
    const team = this.activeTeamFor(leaderSessionId);
    if (!team) return { kind: "no_active_team" };

    return {
      kind: "snapshot",
      team: currentTeam(team),
      workers: [...team.workersByName.values()]
        .map((worker) => ({
          ...currentWorker(worker),
          nonterminalTaskIds: [...(team.taskIdsByWorkerName.get(worker.name) ?? [])].sort(),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      tasks: [...team.tasksById.values()].map((task) => ({ ...task })),
    };
  }

  /** Deterministic trace state for focused probes. It is not a model result. */
  readDebugState(): InMemoryModelToolTeamDebugState {
    return {
      revision: this.revision,
      bindings: [...this.activeTeamIdByLeaderSession]
        .map(([leaderSessionId, teamId]) => ({
          leaderSessionId,
          teamId,
          teamName: this.teamsById.get(teamId)?.name ?? "",
        }))
        .sort((left, right) => left.leaderSessionId.localeCompare(right.leaderSessionId)),
      teams: [...this.teamsById.values()]
        .map((team) => ({
          id: team.id,
          ...currentTeam(team),
          leaderSessionId: team.leaderSessionId,
          workers: [...team.workersByName.values()]
            .map(currentWorker)
            .sort((left, right) => left.name.localeCompare(right.name)),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  private activeTeamFor(leaderSessionId: ExactLeaderSessionId): StoredTeam | undefined {
    const teamId = this.activeTeamIdByLeaderSession.get(leaderSessionId);
    if (!teamId) return undefined;
    const team = this.teamsById.get(teamId);
    return team?.lifecycle === "active" ? team : undefined;
  }
}
