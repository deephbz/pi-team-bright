import { hostEnv } from "../env/host-env";
import { taskVersionRef, type TaskVersionRef } from "../task-authority/task-version-ref";
import type { CanonicalTaskCard, TaskCard } from "../task-authority/task-domain";
import type { ModelToolTaskJournalEntry, ModelToolTaskUpdateInput } from "../task-authority/contracts";
import type { ModelToolTeamApplicationPort, ModelToolTaskApplicationPort, ModelToolAlertApplicationPort, ModelToolCoordinationApplicationPort } from "./model-tool-journey-port";
import type { AlertTarget, AlertSendPortResult, CreateTaskGraphPortResult, CreateTaskPortResult, CreateTeamPortResult, EnsureWorkerExecutionContext, EnsureWorkerPortResult, ExactLeaderSessionId, ModelToolTaskGraphInput, ModelToolTeamCurrent, ModelToolWorkerCurrent, PendingObservation, ReadTasksPortResult, TaskLinkPortInput, TaskLinkPortResult, TaskUpdatePortOutcome, TeamShutdownPortResult, TeamSnapshotPortResult, TeamSyncPortResult, UpdateTasksPortResult, WorkerStopPortResult } from "./model-tool-contracts";
import { TaskGraphValidationError, validateTaskGraph } from "../task-authority/dag";
import type { InMemoryAlertState, InMemoryCoordinationState, InMemoryEvent, InMemorySupportRevisionClock, InMemoryTaskRecord, InMemoryTaskState, InMemoryTeamRecord, InMemoryTeamState } from "./in-memory-state";

export interface InMemoryTeamQuery { active(session: ExactLeaderSessionId): InMemoryTeamRecord | undefined; worker(teamId: string, name: string): ModelToolWorkerCurrent | undefined; snapshot(team: InMemoryTeamRecord): { team: ModelToolTeamCurrent; modelRoles: Array<{ name: string; use: string }>; workers: ModelToolWorkerCurrent[] }; }
export interface InMemoryTaskQuery { record(teamId: string): InMemoryTaskRecord; tasks(teamId: string): TaskCard[]; nonterminalAssigned(teamId: string, worker: string): string[]; }
export type InMemoryPublicationResult = { kind: "published" } | { kind: "failed"; message: string };
export interface InMemoryCoordinationPublication { publish(event: InMemoryEvent, source: "task" | "alert" | "team"): InMemoryPublicationResult; }
export interface InMemorySupportRevision { commit(): number; read(): number; }
const cloneTask = (task: TaskCard): TaskCard => ({ ...task });
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const taskKey = (taskId: string, operationId: string) => `${taskId}\u0000${operationId}`;
const legacyTransition = (status: TaskCard["status"]): "claim" | "block" | "context_updated" => status === "in_progress" ? "claim" : status === "blocked" ? "block" : "context_updated";
const graphCard = (task: TaskCard): CanonicalTaskCard => ({
  id: task.id,
  title: task.title,
  goal: "goal" in task ? task.goal : "Graph fixture goal is incomplete.",
  current_context: task.current_context,
  version: task.version,
  assignee: task.assignee!,
  needs: (task.relations ?? []).filter((relation) => relation.relation === "blocked_by").map((relation) => relation.target_task_id),
  relations: [...(task.relations ?? [])],
  dependency_state: task.dependency_state,
  status: task.dependency_state?.kind === "waiting" ? "dependency_waiting" as const : "ready" as const,
  state: task.dependency_state?.kind === "waiting"
    ? { kind: "dependency_waiting" as const, prerequisite_task_ids: [...task.dependency_state.active_blocker_ids] }
    : { kind: "ready" as const },
  attempts_started: 0,
});

/** Team fake owns only Team identity, binding, and logical Worker state. */
export class InMemoryTeamApplicationPort implements ModelToolTeamApplicationPort, InMemoryTeamQuery {
  constructor(private readonly state: InMemoryTeamState, private readonly tasks: InMemoryTaskQuery, private readonly publication: InMemoryCoordinationPublication, private readonly revision: InMemorySupportRevision) {}
  active(session: ExactLeaderSessionId) { const id = this.state.bindings.get(session); return id ? this.state.teams.get(id) : undefined; }
  worker(teamId: string, name: string) { return this.state.teams.get(teamId)?.workers.get(name); }
  snapshot(team: InMemoryTeamRecord) { return { team: { name: team.name, purpose: team.purpose, lifecycle: "active" as const }, modelRoles: [] as Array<{ name: string; use: string }>, workers: [...team.workers.values()].map(worker => ({ ...worker })) }; }
  async createTeam(session: ExactLeaderSessionId, input: { name: string; purpose: string }) : Promise<CreateTeamPortResult> {
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
  async shutdownTeam(session: ExactLeaderSessionId): Promise<TeamShutdownPortResult> { const team = this.active(session); if (!team) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." }; const stoppedWorkers = [...team.workers.keys()]; const unfinishedTaskIds = this.tasks.tasks(team.id).filter(task => task.status !== "closed").map(task => task.id); team.workers.clear(); this.revision.commit(); return { kind: "shutdown", stoppedWorkers, unfinishedTaskIds }; }
}

/** Task fake owns Task cards, journals, replay receipts, and Task identifiers. */
export class InMemoryTaskApplicationPort implements ModelToolTaskApplicationPort, InMemoryTaskQuery {
  constructor(private readonly state: InMemoryTaskState, private readonly teams: InMemoryTeamQuery, private readonly publication: InMemoryCoordinationPublication, private readonly revision: InMemorySupportRevision) {}
  record(teamId: string) { let record = this.state.byTeam.get(teamId); if (!record) { record = { tasks: new Map(), journals: new Map(), updates: new Map(), creates: new Map() }; this.state.byTeam.set(teamId, record); } return record; }
  tasks(teamId: string) { return [...this.record(teamId).tasks.values()].map(cloneTask); }
  nonterminalAssigned(teamId: string, worker: string) { return this.tasks(teamId).filter(task => task.assignee === worker && task.status !== "closed").map(task => task.id); }
  async createTaskGraph(session: ExactLeaderSessionId, input: ModelToolTaskGraphInput): Promise<CreateTaskGraphPortResult> {
    const team = this.teams.active(session);
    if (!team) return { kind: "no_active_team", operationId: input.operationId };
    const record = this.record(team.id);
    const fingerprint = JSON.stringify(canonical(input));
    const prior = record.creates.get(input.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return { kind: "refused", operationId: input.operationId, reason: "operation_conflict", message: "The create operation ID was already used with different graph semantics." };
      const tasksByKey = Object.fromEntries(Object.entries(prior.taskIdsByKey).map(([key, taskId]) => {
        return [key, graphCard(cloneTask(record.tasks.get(taskId)!))];
      }));
      return { kind: "created", operationId: input.operationId, replayed: true, graphVersion: "g_0000000000000000", tasksByKey, readyTaskIds: Object.values(tasksByKey).filter(task => task.dependency_state?.kind === "ready").map(task => task.id).sort(), ...(prior.deliveryWarnings?.length ? { deliveryWarnings: [...prior.deliveryWarnings] } : {}) };
    }
    const graphInput = {
      operation_id: input.operationId,
      tasks: input.tasks.map(({ needs: _needs, ...task }) => task),
      dependencies: input.tasks.flatMap(task => task.needs?.length
        ? [{ task: { key: task.key }, needs: task.needs.map(key => ({ key })) }]
        : []),
    };
    try {
      validateTaskGraph(graphInput, { workers: new Set(team.workers.keys()), existingTasks: new Map(record.tasks.values().map(task => [task.id, { id: task.id, version: task.version, status: task.status }])) });
    } catch (error) {
      const graphError = error as TaskGraphValidationError;
      return { kind: "refused", operationId: input.operationId, reason: graphError.code === "worker_unavailable" ? "worker_unavailable" : graphError.code === "version_conflict" ? "version_conflict" : "graph_conflict", message: graphError.message };
    }
    const taskIdsByKey: Record<string, string> = {};
    const staged = new Map<string, TaskCard>();
    for (const node of input.tasks) {
      const id = `task-${this.state.nextTask++}`;
      taskIdsByKey[node.key] = id;
      staged.set(id, { id, title: node.title, goal: node.goal, status: "open", ...(node.assignee ? { assignee: node.assignee } : {}), relations: [], dependency_state: { kind: "ready", active_blocker_ids: [] }, current_context: "Work has not started.", version: taskVersionRef(`${id}:1`) });
    }
    const candidate = new Map([...record.tasks.entries()].map(([id, task]) => [id, { ...task, relations: [...(task.relations ?? [])] } as TaskCard]));
    for (const [id, task] of staged) candidate.set(id, { ...task, relations: [...(task.relations ?? [])] });
    const resolve = (ref: { key: string } | { taskId: string }) => "key" in ref ? taskIdsByKey[ref.key] : ref.taskId;
    const expanded = new Set<string>();
    for (const dependency of graphInput.dependencies) {
      const dependentId = resolve(dependency.task);
      const dependent = candidate.get(dependentId)!;
      for (const need of dependency.needs) dependent.relations!.push({ relation: "blocked_by", target_task_id: resolve(need) });
    }
    for (const taskId of expanded) candidate.get(taskId)!.version = taskVersionRef(`${candidate.get(taskId)!.version}:${input.operationId}`);
    for (const task of candidate.values()) {
      const active = (task.relations ?? []).filter(relation => relation.relation === "blocked_by" && candidate.get(relation.target_task_id)?.status !== "closed").map(relation => relation.target_task_id).sort();
      task.dependency_state = task.status === "closed" || task.status === "blocked" ? { kind: "terminal", active_blocker_ids: active } : active.length ? { kind: "waiting", active_blocker_ids: active } : { kind: "ready", active_blocker_ids: [] };
    }
    record.tasks.clear();
    for (const [id, task] of candidate) record.tasks.set(id, task);
    const warnings: string[] = [];
    for (const task of staged.values()) { const publication = this.publication.publish({ teamId: team.id, kind: "task_created", taskId: task.id }, "task"); if (publication.kind === "failed") warnings.push(publication.message); }
    for (const taskId of expanded) this.publication.publish({ teamId: team.id, kind: "task_updated", taskId, relationChanged: true }, "task");
    record.creates.set(input.operationId, { fingerprint, taskIdsByKey, ...(warnings.length ? { deliveryWarnings: warnings } : {}) });
    this.revision.commit();
    const tasksByKey = Object.fromEntries(Object.entries(taskIdsByKey).map(([key, taskId]) => {
      return [key, graphCard(cloneTask(record.tasks.get(taskId)!))];
    }));
    return { kind: "created", operationId: input.operationId, replayed: false, graphVersion: "g_0000000000000000", tasksByKey, readyTaskIds: Object.values(tasksByKey).filter(task => task.dependency_state?.kind === "ready").map(task => task.id).sort(), ...(warnings.length ? { deliveryWarnings: warnings } : {}) };
  }
  async createTask(session: ExactLeaderSessionId, input: { operationId: string; title: string; goal: string; assignee?: string }): Promise<CreateTaskPortResult> {
    if (!input.assignee) return { kind: "worker_unavailable", operationId: input.operationId };
    const result = await this.createTaskGraph(session, { operationId: input.operationId, tasks: [{ key: "task", title: input.title, goal: input.goal, assignee: input.assignee }] });
    if (result.kind === "created") return { kind: "created", operationId: result.operationId, task: result.tasksByKey.task as TaskCard, ...(result.deliveryWarnings?.length ? { deliveryWarnings: result.deliveryWarnings } : {}) };
    if (result.kind === "refused") return result.reason === "worker_unavailable" ? { kind: "worker_unavailable", operationId: result.operationId } : { kind: "operation_conflict", operationId: result.operationId, message: result.message };
    return result;
  }
  async readTasks(session: ExactLeaderSessionId, taskIds: string[]): Promise<ReadTasksPortResult> { const team = this.teams.active(session); if (!team) return { kind: "no_active_team" }; const record = this.record(team.id); return { kind: "read", tasks: taskIds.map(id => { const task = record.tasks.get(id); return task && cloneTask(task); }) }; }
  async updateTasks(session: ExactLeaderSessionId, updates: ModelToolTaskUpdateInput[]): Promise<UpdateTasksPortResult> {
    if (new Set(updates.map(update => update.taskId)).size !== updates.length) return { kind: "duplicate_task_id" }; const team = this.teams.active(session); if (!team) return { kind: "no_active_team" }; const record = this.record(team.id); const outcomes: TaskUpdatePortOutcome[] = [];
    for (const input of updates) { const task = record.tasks.get(input.taskId); const fingerprint = JSON.stringify(canonical(input)); const key = taskKey(input.taskId, input.operationId); const prior = record.updates.get(key) as { fingerprint: string; outcome: Extract<TaskUpdatePortOutcome, { kind: "updated" }> } | undefined;
      if (prior) { outcomes.push(prior.fingerprint === fingerprint ? { ...prior.outcome, task: cloneTask(prior.outcome.task as TaskCard), journalEntries: prior.outcome.journalEntries.map(entry => ({ ...entry })) } : { kind: "refused", taskId: input.taskId, operationId: input.operationId, reason: "operation_conflict", message: "The operation ID was already used with different input.", ...(task ? { currentTask: cloneTask(task) } : {}) }); continue; }
      if (!task) { outcomes.push({ kind: "refused", taskId: input.taskId, operationId: input.operationId, reason: "task_not_found", message: "The Task does not exist in the exact active Team." }); continue; }
      if (task.version !== input.expectedVersion) { outcomes.push({ kind: "refused", taskId: input.taskId, operationId: input.operationId, reason: "version_conflict", message: `Expected Task version ${input.expectedVersion}, but current version is ${task.version}.`, currentTask: cloneTask(task) }); continue; }
      const updated: TaskCard = { ...task, ...(input.currentContext !== undefined ? { current_context: input.currentContext } : {}), ...(input.status ? { status: input.status } : {}), version: taskVersionRef(task.version) }; const journalEntries = (input.journalEntries ?? []).map(entry => ({ id: `journal-${input.taskId}-${this.state.nextJournal++}`, at: new Date(hostEnv().clock.now()).toISOString(), actor: "leader" as const, kind: entry.kind, text: entry.text })); record.tasks.set(task.id, updated); record.journals.set(task.id, [...(record.journals.get(task.id) ?? []), ...journalEntries]); const outcome = { kind: "updated" as const, taskId: task.id, operationId: input.operationId, replayed: false, transition: legacyTransition(updated.status), readyTaskIds: [] as string[], task: cloneTask(updated), journalEntries: journalEntries.map(entry => ({ ...entry })) }; record.updates.set(key, { fingerprint, outcome }); this.revision.commit(); this.publication.publish({ teamId: team.id, kind: "task_updated", taskId: task.id, journalEntries, statusChanged: task.status !== updated.status }, "task"); outcomes.push(outcome);
    } return { kind: "batch", outcomes };
  }
  async linkTask(_session: ExactLeaderSessionId, input: TaskLinkPortInput): Promise<TaskLinkPortResult> { return { kind: "unavailable", reason: "task_authority_unavailable", message: `The in-memory model-tool port has no relation authority for ${input.taskId}.` }; }
}

/** Alert fake owns Alert identity. Delivery acceptance commits before publication. */
export class InMemoryAlertApplicationPort implements ModelToolAlertApplicationPort {
  constructor(private readonly state: InMemoryAlertState, private readonly teams: InMemoryTeamQuery, private readonly publication: InMemoryCoordinationPublication, private readonly revision: InMemorySupportRevision) {}
  readAcceptedDeliveries() { return this.state.deliveries.map(delivery => ({ ...delivery, recipients: [...delivery.recipients] })); }
  async sendAlert(session: ExactLeaderSessionId, input: { target: AlertTarget; kind: "clarification" | "attention" | "announcement"; text: string; taskId?: string; taskVersion?: TaskVersionRef }): Promise<AlertSendPortResult> { const team = this.teams.active(session); if (!team) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." }; if (input.target.kind === "team" && input.kind !== "announcement") return { kind: "refused", reason: "invalid_fanout", message: "Only announcement Alerts may target the whole Team." }; const acceptedRecipients = (input.target.kind === "team" ? [...team.workers.keys()] : [input.target.name]).filter(name => team.workers.has(name)); if (!acceptedRecipients.length) return { kind: "refused", reason: input.target.kind === "team" ? "no_eligible_recipients" : "recipient_not_current", message: "No current recipient accepted the Alert." }; const alertId = `alert-${this.revision.read() + this.state.nextAlert++}`; this.state.deliveries.push({ id: alertId, teamId: team.id, recipients: [...acceptedRecipients], kind: input.kind, text: input.text }); this.revision.commit(); const publication = this.publication.publish({ teamId: team.id, kind: "alert_sent" }, "alert"); return publication.kind === "published" ? { kind: "sent", alertId, acceptedRecipients, failedRecipients: [] } : { kind: "unavailable", reason: "team_authority_unavailable", message: publication.message }; }
}

export { InMemoryCoordinationApplicationPort } from "./in-memory-coordination";
