import * as teamEvents from "../coordination/event-journal";
import { currentMember, deriveWorkerRunObservation, livenessIsComplete, livenessIsProductive, waitForLivenessHint, type WorkerRunObservation } from "../utils/sync-liveness";
import { DEFAULT_SYNC_WAIT_SECONDS } from "../utils/sync-liveness-settings";
import { readTaskEventFailureHintsAfter } from "../utils/task-event-failure-hints";
import { taskVersionRef } from "../task-authority/task-version-ref";
import type { TaskCard, TaskCardWarning } from "../task-authority/task-domain";
import type { TeamEvent } from "./contracts";
import type { CoordinationHiddenObservationPort, CoordinationHiddenObservationProjection, CoordinationQueryBundle, CoordinationTaskReadOutcome, CoordinationLeaderBindingEvidence } from "./queries";
import { CoordinationNudgeDebtService, type CoordinationNudgeStore, type SyncNudgeDebt } from "./nudge-debt";
import { taskProjectionRevision } from "./task-projection-revision";
export { taskProjectionRevision } from "./task-projection-revision";
import type { CoordinationObservationBinding, CoordinationPendingObservation, CoordinationSnapshotResult, CoordinationSyncResult, CoordinationTaskProjection, CoordinationTeamCurrent, CoordinationWorkerCurrent } from "./observation-contracts";

type TaskProjection = CoordinationTaskProjection;
type TaskProjectionReadResult = | ({ kind: "tasks" } & TaskProjection) | Extract<CoordinationSyncResult, { kind: "contract_gap" | "unavailable" }>;
type BoundTeam = { teamName: string; config: Required<Pick<CoordinationLeaderBindingEvidence, "teamName" | "sessionFile" | "members">> & CoordinationLeaderBindingEvidence & { epochId: string }; sessionFile: string };
export interface CoordinationProjectionDependencies {
  projectNonterminalTaskIds(tasks: readonly TaskCard[], workerName: string): string[];
  projectTaskChanges(events: readonly TeamEvent[], tasks: readonly TaskCard[]): { kind: "projected"; changes: Array<{ taskId: string; changeKinds: Array<"created" | "goal" | "assignment" | "progress" | "status" | "relation">; journalEntries: import("../task-authority/contracts").ModelToolTaskJournalEntry[]; current: TaskCard }> } | Extract<CoordinationSyncResult, { kind: "contract_gap" }>;
}

function asNumber(cursor: string): number { const value = Number(cursor); return Number.isSafeInteger(value) ? value : 0; }
function isAbort(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
function currentTeam(config: CoordinationLeaderBindingEvidence): CoordinationTeamCurrent { return { name: config.teamName, purpose: config.purpose ?? "", lifecycle: "active" }; }
function latestMember(config: CoordinationLeaderBindingEvidence, workerName: string) { return [...config.members].reverse().find((member) => member.name === workerName && member.isActive !== false); }
function workerCarrier(member: ReturnType<typeof latestMember>): CoordinationWorkerCurrent["carrier"] { return !member ? "absent" : member.sessionFile ? "connected" : member.pendingLaunchId ? "starting" : "absent"; }
function workerEventChange(event: Extract<TeamEvent, { type: "worker" }>): "created" | "connected" | "stopped" | "failed" { return event.phase === "prepared" ? "created" : event.phase === "session_bound" ? "connected" : event.phase; }

export interface CoordinationObservationStore {
  /** Coordination-owned hidden record port, exposed as observation operations. */
  readHidden: CoordinationHiddenObservationPort["read"];
  commitHidden: CoordinationHiddenObservationPort["commit"];
  readEvents: typeof teamEvents.readTeamEvents;
  readEventCursor: typeof teamEvents.readTeamEventCursor;
  waitEvents: typeof teamEvents.waitForTeamEvents;
  readFailureHints: typeof readTaskEventFailureHintsAfter;
}

export interface CoordinationWaitDependencies {
  waitForLivenessHint: typeof waitForLivenessHint;
}

export function createDurableCoordinationObservationStore(hidden: CoordinationHiddenObservationPort): CoordinationObservationStore {
  return {
    readHidden: (...args) => hidden.read(...args),
    commitHidden: (...args) => hidden.commit(...args),
    readEvents: (...args) => teamEvents.readTeamEvents(...args),
  readEventCursor: (...args) => teamEvents.readTeamEventCursor(...args),
  waitEvents: (...args) => teamEvents.waitForTeamEvents(...args),
    readFailureHints: (...args) => readTaskEventFailureHintsAfter(...args),
  };
}

/** Coordination observation algorithm. Dependencies supply authority reads and durable projection storage. */
export class CoordinationObservationService {
  private readonly branchLineages = new Map<string, string[]>();
  private readonly pendingBySession = new Map<string, any>();
  private readonly taskProjections = new Map<string, any>();
  private readonly nudgeDebt?: CoordinationNudgeDebtService;
  constructor(
    private readonly coordinationQueries: CoordinationQueryBundle,
    private readonly projection: CoordinationProjectionDependencies,
    private readonly store: CoordinationObservationStore,
    private readonly wait: CoordinationWaitDependencies = { waitForLivenessHint },
    nudgeStore?: CoordinationNudgeStore,
  ) { this.nudgeDebt = nudgeStore ? new CoordinationNudgeDebtService(this, nudgeStore) : undefined; }
  setBranchContext(sessionId: string, branchLineage: string[]): void { this.branchLineages.set(sessionId, [...branchLineage]); }
  branchContext(sessionId: string): string[] { return [...(this.branchLineages.get(sessionId) ?? [])]; }
  pending(sessionId: string): CoordinationPendingObservation<CoordinationSyncResult> | undefined { const pending = this.pendingBySession.get(sessionId); return pending ? { sessionId: pending.sessionId, toolCallId: pending.toolCallId, resultText: pending.resultText, resultDigest: pending.resultDigest, head: pending.head, epochId: pending.epochId, result: pending.internalResult } : undefined; }
  stagedResult(sessionId: string): CoordinationSyncResult | undefined { return this.pendingBySession.get(sessionId)?.internalResult; }
  setPendingResult(sessionId: string, result: unknown): void { const pending = this.pendingBySession.get(sessionId); if (pending) { pending.resultText = JSON.stringify(result); pending.resultDigest = ""; } }
  clearPending(sessionId: string): void { this.pendingBySession.delete(sessionId); }
  takePending(sessionId: string): any { return this.pendingBySession.get(sessionId); }
  storeStage(sessionId: string, observation: any): void { this.pendingBySession.set(sessionId, { ...observation, ...(observation.taskProjection ? { taskProjection: structuredClone(observation.taskProjection) } : {}) }); }
  private taskProjectionKey(teamName: string, epochId: string, exactSessionId: string): string { return JSON.stringify([teamName, epochId, exactSessionId]); }
  private cachedTaskProjection(teamName: string, epochId: string, exactSessionId: string, acknowledgedEntryId: string, acknowledgedLineage: readonly string[], teamEventCursor: string): TaskProjection | undefined { const cached = this.taskProjections.get(this.taskProjectionKey(teamName, epochId, exactSessionId)); if (!cached || cached.acknowledgedEntryId !== acknowledgedEntryId || cached.teamEventCursor !== teamEventCursor || JSON.stringify(cached.acknowledgedLineage) !== JSON.stringify(acknowledgedLineage)) return undefined; return structuredClone(cached.projection); }
  private cacheTaskProjection(cache: any): void { this.taskProjections.set(this.taskProjectionKey(cache.teamName, cache.epochId, cache.exactSessionId), { ...cache, acknowledgedLineage: [...cache.acknowledgedLineage], projection: structuredClone(cache.projection) }); }
  async readSnapshot(exactSessionFile: string): Promise<CoordinationSnapshotResult> { const bound = await this.boundTeam(exactSessionFile); if (!bound) return { kind: "no_active_team" }; return this.readSnapshotForBound(bound); }
  private async readSnapshotForBound(bound: BoundTeam): Promise<CoordinationSnapshotResult> { const tasks = await this.readTaskProjection(bound.teamName); if (tasks.kind !== "tasks") return tasks; const workers = this.readWorkers(bound, tasks.tasks); return { kind: "snapshot", team: currentTeam(bound.config), workers, tasks: tasks.tasks, ...(tasks.warnings.length ? { taskProjectionWarnings: tasks.warnings } : {}) }; }
  async acknowledge(exactSessionFile: string, entryId: string, branchIds: string[]): Promise<boolean> { const pending = this.takePending(exactSessionFile); if (!pending || !branchIds.includes(entryId)) return false; const committed = await this.store.commitHidden(pending.teamName, { teamEpochId: pending.epochId, exactSessionId: pending.sessionId, branchLineage: branchIds, acknowledgedEntryId: entryId, teamEventCursor: String(pending.head), authorityRevisions: pending.authorityRevisions }); if (committed.kind !== "committed") return false; if (pending.taskProjection) this.cacheTaskProjection({ teamName: pending.teamName, epochId: pending.epochId, exactSessionId: pending.sessionId, acknowledgedEntryId: committed.projection.acknowledgedEntryId, acknowledgedLineage: [...committed.projection.acknowledgedLineage], teamEventCursor: committed.projection.teamEventCursor, projection: pending.taskProjection }); this.clearPending(exactSessionFile); return true; }
  private async boundTeam(sessionFile: string): Promise<BoundTeam | undefined> { const config = await this.coordinationQueries.teamRuntime.readLeaderBinding?.(sessionFile); if (!config?.epochId || !config.logicalWorkers) return undefined; return { teamName: config.teamName, config: config as BoundTeam["config"], sessionFile }; }
  /** Exact nudge binding deliberately excludes logical-Worker observation requirements. */
  private async nudgeBoundTeam(sessionFile: string): Promise<BoundTeam | undefined> {
    const config = await this.coordinationQueries.teamRuntime.readLeaderBinding?.(sessionFile);
    const lead = config?.members && [...config.members].reverse().find((member) => member.name === "team-lead" && member.agentType === "lead" && member.isActive !== false && member.sessionFile === sessionFile && member.membershipId);
    if (!config?.epochId || !config.syncLiveness || !lead) return undefined;
    return { teamName: config.teamName, config: config as BoundTeam["config"], sessionFile };
  }
  async readSyncNudgeDebt(exactSessionFile: string, branchLineage: string[]): Promise<SyncNudgeDebt> {
    const bound = await this.nudgeBoundTeam(exactSessionFile);
    const policy = bound?.config.syncLiveness;
    if (!this.nudgeDebt || !bound || !policy?.nudgeEnabled || policy.nudgeDelaySeconds === undefined) return { kind: "none" };
    return this.nudgeDebt.read({
      teamName: bound.teamName,
      sessionFile: bound.sessionFile,
      config: { ...bound.config, syncLiveness: { waitSeconds: policy.waitSeconds, nudgeEnabled: policy.nudgeEnabled, nudgeDelaySeconds: policy.nudgeDelaySeconds, policyVersion: policy.policyVersion } },
    }, branchLineage);
  }
  async readTeamSync(
    exactSessionFile: string,
    view: "snapshot" | "updates",
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<CoordinationSyncResult> {
    const bound = await this.boundTeam(exactSessionFile);
    if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    const pending = this.stagedResult(exactSessionFile);
    if (pending !== undefined) return pending;
    const branchLineage = this.branchContext(exactSessionFile);
    if (view === "updates") {
      const observation = await this.store.readHidden(bound.teamName, {
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
      let batch = this.store.readEvents(bound.teamName, { afterCursor: observation.projection.teamEventCursor });
      let tasksResult: TaskProjection | undefined;
      let taskRevisionChanged = false;
      let externallyChangedTaskIds: string[] = [];
      if (batch.events.length === 0) {
        // A quiet journal cannot prove that an external Task writer did not
        // change state, so read the complete authority projection first.
        const complete = await this.readTaskProjection(bound.teamName);
        if (complete.kind !== "tasks") return complete;
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
                batch = await this.store.waitEvents({ teamName: bound.teamName, afterCursor: observation.projection.teamEventCursor, waitMs: 0, signal });
                const beforeWait = tasksResult;
                const rechecked = await this.readTaskProjection(bound.teamName);
                if (rechecked.kind !== "tasks") return rechecked;
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
                const result: Extract<CoordinationSyncResult, { kind: "caught_up" }> = { kind: "caught_up", head: asNumber(batch.headCursor), epochId: bound.config.epochId! };
                this.stage(exactSessionFile, bound.sessionFile, toolCallId, result, asNumber(batch.headCursor), bound.config.epochId!, bound.teamName, view, {
                  team_events: String(asNumber(batch.headCursor)),
                  task_projection: taskProjectionRevision(tasksResult.tasks, tasksResult.warnings),
                  task_event_failure_hints: this.taskEventFailureHintCursor(bound.teamName, bound.config.epochId!, tasksResult.tasks, observation.projection.authorityRevisions.task_event_failure_hints ?? "0"),
                }, tasksResult);
                return result;
              }
            } else {
              const result: Extract<CoordinationSyncResult, { kind: "caught_up" }> = { kind: "caught_up", head: asNumber(batch.headCursor), epochId: bound.config.epochId! };
              this.stage(exactSessionFile, bound.sessionFile, toolCallId, result, asNumber(batch.headCursor), bound.config.epochId!, bound.teamName, view, {
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
              const next = this.store.readEvents(bound.teamName, { afterCursor: observation.projection.teamEventCursor });
              if (next.events.length > 0) return true;
              const current = await this.workerRunObservations(bound);
              return current.some((item, index) => item.state !== observations[index]?.state || item.actuationPending !== observations[index]?.actuationPending);
            };
            const authorityHint = async (): Promise<boolean> => {
              if (await producerHint()) return true;
              const currentTasks = await this.readTaskProjection(bound.teamName);
              return currentTasks.kind === "tasks" && observation.projection.authorityRevisions.task_projection !== taskProjectionRevision(currentTasks.tasks, currentTasks.warnings);
            };
            await this.wait.waitForLivenessHint({ teamName: bound.teamName, waitMs, signal, authorityCheckMs: 5_000, check: producerHint, checkAuthority: authorityHint });
            batch = this.store.readEvents(bound.teamName, { afterCursor: observation.projection.teamEventCursor });
            const beforeWait = tasksResult;
            const rechecked = await this.readTaskProjection(bound.teamName);
            if (rechecked.kind !== "tasks") return rechecked;
            tasksResult = rechecked;
            externallyChangedTaskIds = beforeWait ? this.changedTaskIds(beforeWait, rechecked) : [];
            taskRevisionChanged = observation.projection.authorityRevisions.task_projection !== taskProjectionRevision(tasksResult.tasks, tasksResult.warnings);
            if (batch.events.length === 0 && !taskRevisionChanged) {
              const afterWait = await this.workerRunObservations(bound);
              if (livenessIsComplete(afterWait)) {
                const result: Extract<CoordinationSyncResult, { kind: "caught_up" }> = { kind: "caught_up", head: asNumber(batch.headCursor), epochId: bound.config.epochId! };
                this.stage(exactSessionFile, bound.sessionFile, toolCallId, result, asNumber(batch.headCursor), bound.config.epochId!, bound.teamName, view, {
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
        const baseline = tasksResult ?? this.cachedProjectionForBound(bound, observation.projection);
        if (!baseline) {
          // A restarted port has no memory cache. A complete authority rescan
          // is the safe recovery path; it is never merged from another branch.
          const recovered = await this.readTaskProjection(bound.teamName);
          if (recovered.kind !== "tasks") return recovered;
          tasksResult = recovered;
        } else {
          tasksResult = baseline;
        }
        const idsToHydrate = this.staleEventTaskIds(batch.events, tasksResult);
        if (idsToHydrate.length > 0) {
          const refreshed = await this.hydrateTaskIds(bound.teamName, idsToHydrate);
          if (refreshed.kind !== "tasks") return refreshed;
          tasksResult = this.mergeTaskProjection(tasksResult, refreshed);
        }
      }
      if (!tasksResult) {
        throw new Error("Task authority did not produce a complete Team observation.");
      }
      const projected = await this.projectUpdates(bound, batch.events, observation.projection, tasksResult.tasks, taskRevisionChanged, tasksResult.warnings, externallyChangedTaskIds);
      if (projected.kind !== "updates") return projected;
      // The page cursor is the last event represented in this result. The
      // journal head may include later pages that have not been projected.
      const pageCursor = asNumber(batch.cursor);
      this.stage(exactSessionFile, bound.sessionFile, toolCallId, projected, pageCursor, bound.config.epochId!, bound.teamName, view, {
        team_events: String(pageCursor),
        task_projection: taskProjectionRevision(tasksResult.tasks, tasksResult.warnings),
        task_event_failure_hints: this.taskEventFailureHintCursor(bound.teamName, bound.config.epochId!, tasksResult.tasks, observation.projection.authorityRevisions.task_event_failure_hints ?? "0"),
      }, tasksResult);
      return projected;
    }
    const snapshot = await this.readSnapshotForBound(bound);
    if (snapshot.kind !== "snapshot") {
      if (snapshot.kind === "contract_gap" || snapshot.kind === "unavailable") return snapshot;
      return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    }
    const head = this.store.readEventCursor(bound.teamName);
    const result: Extract<CoordinationSyncResult, { kind: "snapshot" }> = { ...snapshot, head: asNumber(head), epochId: bound.config.epochId! };
    this.stage(exactSessionFile, bound.sessionFile, toolCallId, result, asNumber(head), bound.config.epochId!, bound.teamName, view, {
      team_events: String(asNumber(head)),
      task_projection: taskProjectionRevision(result.tasks, result.taskProjectionWarnings),
      task_event_failure_hints: this.taskEventFailureHintCursor(bound.teamName, bound.config.epochId!, result.tasks, "0"),
    }, { tasks: result.tasks, warnings: result.taskProjectionWarnings ?? [] });
    return result;
  }

  private taskEventFailureHintCursor(teamName: string, teamEpochId: string, tasks: readonly TaskCard[], afterCursor: string): string {
    return this.store.readFailureHints(teamName, afterCursor, {
      teamEpochId,
      taskReferences: tasks.map((task) => ({ taskId: task.id, taskVersion: taskVersionRef(task.version) })),
    }).headCursor;
  }

  async readTaskProjection(teamName: string): Promise<TaskProjectionReadResult> {
    try {
      const taskIds = await this.coordinationQueries.taskStateDelivery.listTaskIds(teamName);
      const records = await this.coordinationQueries.taskStateDelivery.readTasks(teamName, taskIds);
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
    } catch (error) {
      return { kind: "unavailable", reason: "task_authority_unavailable", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private cachedProjectionForBound(
    bound: BoundTeam,
    observation: CoordinationHiddenObservationProjection,
  ): TaskProjection | undefined {
    return this.cachedTaskProjection(
      bound.teamName,
      bound.config.epochId!,
      bound.sessionFile,
      observation.acknowledgedEntryId,
      observation.acknowledgedLineage,
      observation.teamEventCursor,
    );
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
    records: readonly CoordinationTaskReadOutcome[],
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
  private async hydrateTaskIds(teamName: string, taskIds: readonly string[]): Promise<TaskProjectionReadResult> {
    if (taskIds.length === 0) return { kind: "tasks", tasks: [], warnings: [] };
    try {
      const records = await this.coordinationQueries.taskStateDelivery.readTasks(teamName, taskIds);
      this.assertCompleteTaskBatch(taskIds, records, "event Task");
      const tasks = records.map((record, index) => {
        if (!record || record.kind !== "found") {
          throw new Error(`Task ${taskIds[index]} referenced by a Team event could not be hydrated.`);
        }
        return record.task;
      });
      return { kind: "tasks", tasks, warnings: tasks.flatMap((task) => task.projection_warnings ?? []) };
    } catch (error) {
      return { kind: "unavailable", reason: "task_authority_unavailable", message: error instanceof Error ? error.message : String(error) };
    }
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

  private readWorkers(bound: BoundTeam, taskProjection: TaskCard[]): Array<CoordinationWorkerCurrent & { nonterminalTaskIds: string[] }> {
    return (bound.config.logicalWorkers ?? []).map((logical) => {
      const member = latestMember(bound.config, logical.name);
      return {
        name: logical.name,
        scope: logical.scope,
        carrier: workerCarrier(member),
        nonterminalTaskIds: this.projection.projectNonterminalTaskIds(taskProjection, logical.name),
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
  }

  private async workerRunObservations(bound: BoundTeam): Promise<WorkerRunObservation[]> {
    const workers = bound.config.logicalWorkers ?? [];
    return Promise.all(workers.map(async (worker) => {
      const member = [...bound.config.members].reverse().find((candidate) => candidate.name === worker.name && candidate.isActive !== false);
      if (!member) return { worker: worker.name, state: "absent" as const, actuationPending: false };
      const [taskDelivery, alertInbox, runtime] = await Promise.all([
        this.coordinationQueries.taskStateDelivery.readDeliveryEvidence(bound.teamName, member.name),
        this.coordinationQueries.alertActuation.readInboxEvidence(bound.teamName, member.name),
        this.coordinationQueries.teamRuntime.readRuntime(bound.teamName, member).catch(() => null),
      ]);
      return deriveWorkerRunObservation(member, { runtime, taskDelivery, alertInbox });
    }));
  }

  private async projectUpdates(bound: BoundTeam, events: TeamEvent[], observation: CoordinationHiddenObservationProjection, taskProjection?: TaskCard[], taskRevisionChanged = false, taskWarnings: TaskCardWarning[] = [], externallyChangedTaskIds: readonly string[] = []): Promise<Extract<CoordinationSyncResult, { kind: "updates" | "contract_gap" | "unavailable" }>> {
    const taskResult = taskProjection ? { kind: "tasks" as const, tasks: taskProjection, warnings: taskWarnings } : await this.readTaskProjection(bound.teamName);
    if (taskResult.kind !== "tasks") return taskResult;
    const workerChanges: Array<{ worker: string; scope: string; kind: "created" | "connected" | "stopped" | "failed" | "scope_changed"; text: string }> = [];
    for (const event of events) {
      if (event.type !== "worker") continue;
      const logical = bound.config.logicalWorkers?.find((worker) => worker.name === event.worker);
      if (!logical) continue;
      workerChanges.push({ worker: logical.name, scope: logical.scope, kind: workerEventChange(event), text: `Worker ${logical.name} ${event.phase.replaceAll("_", " ")}.` });
    }
    const taskChanges = events.length > 0
      ? this.projection.projectTaskChanges(events, taskResult.tasks)
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
    const result: Extract<CoordinationSyncResult, { kind: "updates" }> = {
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

  private stage(sessionId: string, exactSessionFile: string, toolCallId: string, result: CoordinationSyncResult, head: number, epochId: string, teamName: string, view: "snapshot" | "updates", authorityRevisions: Record<string, string> = { team_events: String(head) }, taskProjection?: TaskProjection): void {
    this.storeStage(sessionId, {
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
