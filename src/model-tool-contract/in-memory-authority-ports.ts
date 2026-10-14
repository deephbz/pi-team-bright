import type { TaskVersionRef } from "../task-authority/task-version-ref";
import { isTaskTerminal, type CanonicalTaskCard } from "../task-authority/task-domain";
import { GraphControlRefusal, GraphTaskController } from "../task-authority/graph-control";
import { projectGraphTaskCards } from "../task-authority/graph-card";
import type { ModelToolTeamApplicationPort, ModelToolTaskApplicationPort, ModelToolAlertApplicationPort } from "./model-tool-journey-port";
import type { AlertTarget, AlertSendPortResult, CreateTaskGraphPortResult, CreateTeamPortResult, EnsureWorkerExecutionContext, EnsureWorkerPortResult, ExactLeaderSessionId, ModelToolGraphTaskUpdateInput, ModelToolTaskGraphInput, ModelToolTeamCurrent, ModelToolWorkerCurrent, ReadTasksPortResult, TaskUpdatePortOutcome, TeamShutdownPortResult, UpdateTasksPortResult, WorkerStopPortResult } from "./model-tool-contracts";
import type { InMemoryAlertState, InMemoryEvent, InMemoryTaskRecord, InMemoryTaskState, InMemoryTeamRecord, InMemoryTeamState } from "./in-memory-state";

export interface InMemoryTeamQuery { active(session: ExactLeaderSessionId): InMemoryTeamRecord | undefined; worker(teamId: string, name: string): ModelToolWorkerCurrent | undefined; snapshot(team: InMemoryTeamRecord): { team: ModelToolTeamCurrent; modelRoles: Array<{ name: string; use: string }>; workers: ModelToolWorkerCurrent[] }; }
export interface InMemoryTaskQuery { record(teamId: string): InMemoryTaskRecord; tasks(teamId: string): CanonicalTaskCard[]; nonterminalAssigned(teamId: string, worker: string): string[]; }
export type InMemoryPublicationResult = { kind: "published" } | { kind: "failed"; message: string };
export interface InMemoryCoordinationPublication { publish(event: InMemoryEvent, source: "task" | "alert" | "team"): InMemoryPublicationResult; }
export interface InMemorySupportRevision { commit(): number; read(): number; }

/** Team fake owns Team identity, binding, and logical Worker state. */
export class InMemoryTeamApplicationPort implements ModelToolTeamApplicationPort, InMemoryTeamQuery {
  constructor(private readonly state: InMemoryTeamState, private readonly tasks: InMemoryTaskQuery, private readonly publication: InMemoryCoordinationPublication, private readonly revision: InMemorySupportRevision) {}
  active(session: ExactLeaderSessionId) { const id = this.state.bindings.get(session); return id ? this.state.teams.get(id) : undefined; }
  worker(teamId: string, name: string) { return this.state.teams.get(teamId)?.workers.get(name); }
  snapshot(team: InMemoryTeamRecord) { return { team: { name: team.name, purpose: team.purpose, lifecycle: "active" as const }, modelRoles: [] as Array<{ name: string; use: string }>, workers: [...team.workers.values()].map(worker => ({ ...worker })) }; }
  async createTeam(session: ExactLeaderSessionId, input: { name: string; purpose: string }): Promise<CreateTeamPortResult> {
    if (this.active(session)) return { kind: "refused", reason: "active_team_exists" };
    if (this.state.names.has(input.name)) return { kind: "refused", reason: "name_unavailable" };
    const team: InMemoryTeamRecord = { id: `in-memory-team-${this.state.next++}`, leaderSessionId: session, name: input.name, purpose: input.purpose, workers: new Map() };
    this.state.teams.set(team.id, team); this.state.names.set(team.name, team.id); this.state.bindings.set(session, team.id); this.revision.commit();
    this.publication.publish({ teamId: team.id, kind: "team_created" }, "team");
    return { kind: "created", team: this.snapshot(team).team, modelRoles: [] };
  }
  async ensureWorker(session: ExactLeaderSessionId, input: { name: string; scope: string; model_role?: string }, _execution?: EnsureWorkerExecutionContext): Promise<EnsureWorkerPortResult> {
    const team = this.active(session); if (!team) return { kind: "no_active_team" };
    if (input.model_role !== undefined) return { kind: "invalid_model_role", message: "The in-memory Team port cannot resolve model roles; use the durable Team port.", validModelRoles: [] };
    const existing = team.workers.get(input.name); if (existing) return existing.scope === input.scope ? { kind: "reused", worker: { ...existing } } : { kind: "scope_conflict", worker: { ...existing } };
    const worker: ModelToolWorkerCurrent = { name: input.name, scope: input.scope, carrier: "absent" }; team.workers.set(worker.name, worker); this.revision.commit();
    this.publication.publish({ teamId: team.id, kind: "worker_created", workerName: worker.name }, "team"); return { kind: "created", worker: { ...worker } };
  }
  async stopWorker(session: ExactLeaderSessionId, worker: string): Promise<WorkerStopPortResult> {
    const team = this.active(session); if (!team) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    if (worker === "team-lead") return { kind: "refused", worker, reason: "leader_reserved", message: "The Team leader is reserved; use team_shutdown for whole-Team closure." };
    if (!team.workers.has(worker)) return { kind: "refused", worker, reason: "worker_not_found", message: `Worker ${worker} is not current.` };
    const guardingTaskIds = this.tasks.nonterminalAssigned(team.id, worker); if (guardingTaskIds.length) return { kind: "refused", worker, reason: "nonterminal_tasks_assigned", message: "Worker has nonterminal Tasks.", guardingTaskIds };
    team.workers.delete(worker); this.revision.commit(); return { kind: "stopped", worker };
  }
  async shutdownTeam(session: ExactLeaderSessionId): Promise<TeamShutdownPortResult> {
    const team = this.active(session); if (!team) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    const stoppedWorkers = [...team.workers.keys()]; const unfinishedTaskIds = this.tasks.tasks(team.id).filter(task => !isTaskTerminal(task)).map(task => task.id);
    team.workers.clear(); this.revision.commit(); return { kind: "shutdown", stoppedWorkers, unfinishedTaskIds };
  }
}

/** The in-memory application uses the same graph controller as durable authority. */
export class InMemoryTaskApplicationPort implements ModelToolTaskApplicationPort, InMemoryTaskQuery {
  constructor(private readonly state: InMemoryTaskState, private readonly teams: InMemoryTeamQuery, private readonly publication: InMemoryCoordinationPublication, private readonly revision: InMemorySupportRevision) {}
  record(teamId: string) {
    let record = this.state.byTeam.get(teamId);
    if (!record) { record = { controller: new GraphTaskController(), tasks: new Map(), journals: new Map() }; this.state.byTeam.set(teamId, record); }
    return record;
  }
  tasks(teamId: string) { return [...this.record(teamId).tasks.values()].map(task => structuredClone(task)); }
  nonterminalAssigned(teamId: string, worker: string) { return this.tasks(teamId).filter(task => task.assignee === worker && !isTaskTerminal(task)).map(task => task.id); }
  private project(record: InMemoryTaskRecord) { record.tasks = new Map(projectGraphTaskCards(record.controller).map(task => [task.id, task])); }
  async createTaskGraph(session: ExactLeaderSessionId, input: ModelToolTaskGraphInput): Promise<CreateTaskGraphPortResult> {
    const team = this.teams.active(session); if (!team) return { kind: "no_active_team", operationId: input.operationId };
    if (input.tasks.some(task => !team.workers.has(task.assignee))) return { kind: "refused", operationId: input.operationId, reason: "worker_unavailable", message: "Graph assignees must be current Workers." };
    const record = this.record(team.id);
    try {
      const result = record.controller.applyGraph(input);
      this.project(record);
      const warnings: string[] = [];
      if (!result.replayed) {
        this.revision.commit();
        for (const task of record.tasks.values()) {
          const publication = this.publication.publish({ teamId: team.id, kind: "task_created", taskId: task.id }, "task");
          if (publication.kind === "failed") warnings.push(publication.message);
        }
      }
      return { kind: "created", operationId: result.operationId, replayed: result.replayed, graphVersion: result.graphVersion,
        tasksByKey: Object.fromEntries(input.tasks.map(task => [task.key, structuredClone(record.tasks.get(task.key)!)])),
        readyTaskIds: record.controller.selectReadyFrontier().map(task => task.id), ...(warnings.length ? { deliveryWarnings: warnings } : {}) };
    } catch (error) {
      if (!(error instanceof GraphControlRefusal)) throw error;
      return { kind: "refused", operationId: input.operationId, reason: error.code === "operation_conflict" ? "operation_conflict" : error.code === "graph_version_conflict" ? "graph_version_conflict" : "invalid_graph", message: error.message };
    }
  }
  async readTasks(session: ExactLeaderSessionId, taskIds: string[]): Promise<ReadTasksPortResult> {
    const team = this.teams.active(session); if (!team) return { kind: "no_active_team" };
    const record = this.record(team.id); return { kind: "read", tasks: taskIds.map(id => { const task = record.tasks.get(id); return task && structuredClone(task); }) };
  }
  async updateTasks(session: ExactLeaderSessionId, updates: ModelToolGraphTaskUpdateInput[], actor = "team-lead"): Promise<UpdateTasksPortResult> {
    if (new Set(updates.map(update => update.taskId)).size !== updates.length) return { kind: "duplicate_task_id" };
    const team = this.teams.active(session); if (!team) return { kind: "no_active_team" };
    const record = this.record(team.id); const outcomes: TaskUpdatePortOutcome[] = [];
    for (const input of updates) {
      try {
        const result = record.controller.transition({ ...input, ...(input.transition && input.transition !== "cancel" ? { worker: actor } : {}) });
        this.project(record); const task = structuredClone(record.tasks.get(input.taskId)!);
        if (!result.replayed) { this.revision.commit(); this.publication.publish({ teamId: team.id, kind: "task_updated", taskId: task.id, statusChanged: !!input.transition }, "task"); }
        outcomes.push({ kind: "updated", taskId: task.id, operationId: input.operationId, replayed: result.replayed, task, journalEntries: [], transition: input.transition ?? "context_updated", readyTaskIds: record.controller.selectReadyFrontier().map(task => task.id) });
      } catch (error) {
        if (!(error instanceof GraphControlRefusal)) throw error;
        outcomes.push({ kind: "refused", taskId: input.taskId, operationId: input.operationId,
          reason: error.code === "task_version_conflict" ? "version_conflict" : error.code === "task_not_found" || error.code === "operation_conflict" || error.code === "worker_mismatch" || error.code === "worker_occupied" || error.code === "evidence_required" ? error.code : "invalid_transition",
          message: error.message, ...(record.tasks.has(input.taskId) ? { currentTask: structuredClone(record.tasks.get(input.taskId)!) } : {}) });
      }
    }
    return { kind: "batch", outcomes };
  }
}

/** Alert fake commits delivery acceptance before publication. */
export class InMemoryAlertApplicationPort implements ModelToolAlertApplicationPort {
  constructor(private readonly state: InMemoryAlertState, private readonly teams: InMemoryTeamQuery, private readonly publication: InMemoryCoordinationPublication, private readonly revision: InMemorySupportRevision) {}
  readAcceptedDeliveries() { return this.state.deliveries.map(delivery => ({ ...delivery, recipients: [...delivery.recipients] })); }
  async sendAlert(session: ExactLeaderSessionId, input: { target: AlertTarget; kind: "clarification" | "attention" | "announcement"; text: string; taskId?: string; taskVersion?: TaskVersionRef }): Promise<AlertSendPortResult> {
    const team = this.teams.active(session); if (!team) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    if (input.target.kind === "team" && input.kind !== "announcement") return { kind: "refused", reason: "invalid_fanout", message: "Only announcement Alerts may target the whole Team." };
    const acceptedRecipients = (input.target.kind === "team" ? [...team.workers.keys()] : [input.target.name]).filter(name => team.workers.has(name));
    if (!acceptedRecipients.length) return { kind: "refused", reason: input.target.kind === "team" ? "no_eligible_recipients" : "recipient_not_current", message: "No current recipient accepted the Alert." };
    const alertId = `alert-${this.revision.read() + this.state.nextAlert++}`; this.state.deliveries.push({ id: alertId, teamId: team.id, recipients: [...acceptedRecipients], kind: input.kind, text: input.text }); this.revision.commit();
    const publication = this.publication.publish({ teamId: team.id, kind: "alert_sent" }, "alert");
    return publication.kind === "published" ? { kind: "sent", alertId, acceptedRecipients, failedRecipients: [] } : { kind: "unavailable", reason: "team_authority_unavailable", message: publication.message };
  }
}

export { InMemoryCoordinationApplicationPort } from "./in-memory-coordination";
