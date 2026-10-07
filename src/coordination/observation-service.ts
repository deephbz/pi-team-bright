import * as teamEvents from "../coordination/event-journal";
import { currentMember, deriveWorkerRunObservation, livenessIsComplete, livenessIsProductive, waitForLivenessHint, type WorkerRunObservation } from "../utils/sync-liveness";
import { DEFAULT_SYNC_WAIT_SECONDS } from "../utils/sync-liveness-settings";
import { readTaskEventFailureHintsAfter } from "../utils/task-event-failure-hints";
import { taskVersionRef } from "../task-authority/task-version-ref";
import type { CanonicalTaskCard, TaskCardWarning } from "../task-authority/task-domain";
import type { TeamEvent } from "./contracts";
import type { CoordinationHiddenObservationPort, CoordinationHiddenObservationProjection, CoordinationQueryBundle, CoordinationTaskReadOutcome, CoordinationLeaderBindingEvidence } from "./queries";
import { CoordinationNudgeDebtService, type CoordinationNudgeStore, type SyncNudgeDebt } from "./nudge-debt";
import { taskProjectionRevision } from "./task-projection-revision";
import { loadWorkerResourcePolicy } from "../utils/worker-resource-projection";
export { taskProjectionRevision } from "./task-projection-revision";
import type { CoordinationObservationBinding, CoordinationPendingObservation, CoordinationSnapshotResult, CoordinationSyncResult, CoordinationSyncNowResult, CoordinationSyncProbe, CoordinationTaskProjection, CoordinationTeamCurrent, CoordinationWorkerCurrent } from "./observation-contracts";

type TaskProjection = CoordinationTaskProjection;
type TaskProjectionReadResult = | ({ kind: "tasks" } & TaskProjection) | Extract<CoordinationSyncResult, { kind: "contract_gap" | "unavailable" }>;
type BoundTeam = { teamName: string; config: Required<Pick<CoordinationLeaderBindingEvidence, "teamName" | "sessionFile" | "members">> & CoordinationLeaderBindingEvidence & { epochId: string }; sessionFile: string };
export interface CoordinationProjectionDependencies {
  projectNonterminalTaskIds(tasks: readonly CanonicalTaskCard[], workerName: string): string[];
  projectTaskChanges(events: readonly TeamEvent[], tasks: readonly CanonicalTaskCard[]): { kind: "projected"; changes: Array<{ taskId: string; changeKinds: Array<"created" | "goal" | "assignment" | "progress" | "status" | "relation">; journalEntries: import("../task-authority/contracts").ModelToolTaskJournalEntry[]; current: CanonicalTaskCard }> } | Extract<CoordinationSyncResult, { kind: "contract_gap" }>;
}

function asNumber(cursor: string): number { const value = Number(cursor); return Number.isSafeInteger(value) ? value : 0; }
function isAbort(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
function currentTeam(config: CoordinationLeaderBindingEvidence): CoordinationTeamCurrent { return { name: config.teamName, purpose: config.purpose ?? "", lifecycle: "active" }; }
function latestMember(config: CoordinationLeaderBindingEvidence, workerName: string) { return [...config.members].reverse().find((member) => member.name === workerName && member.isActive !== false); }
function workerCarrier(member: ReturnType<typeof latestMember>): CoordinationWorkerCurrent["carrier"] { return !member ? "absent" : member.sessionFile ? "connected" : member.pendingLaunchId ? "starting" : "absent"; }
function workerEventChange(event: Extract<TeamEvent, { type: "worker" }>): "created" | "connected" | "stopped" | "failed" { return event.phase === "prepared" ? "created" : event.phase === "session_bound" ? "connected" : event.phase; }

export interface CoordinationObservationContext {
  /** Exact leader cwd from the context that owns launch and trust resolution. */
  cwd?: string;
  /** Resolved project trust for that exact leader Session. */
  projectTrusted?: boolean;
}

export interface CoordinationObservationStore {
  /** Coordination-owned hidden record port, exposed as observation operations. */
  readHidden: CoordinationHiddenObservationPort["read"];
  commitHidden: CoordinationHiddenObservationPort["commit"];
  readEvents: typeof teamEvents.readTeamEvents;
  /** One journal read for immediate bounded pages. Older injected stores may omit it. */
  readEventPages?: typeof teamEvents.readTeamEventPages;
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
    readEventPages: (...args) => teamEvents.readTeamEventPages(...args),
  readEventCursor: (...args) => teamEvents.readTeamEventCursor(...args),
  waitEvents: (...args) => teamEvents.waitForTeamEvents(...args),
    readFailureHints: (...args) => readTaskEventFailureHintsAfter(...args),
  };
}

/** Coordination observation algorithm. Dependencies supply authority reads and durable projection storage. */
export class CoordinationObservationService {
  private readonly branchLineages = new Map<string, string[]>();
  private readonly pendingBySession = new Map<string, any>();
  private readonly inFlightBySession = new Set<string>();
  private readonly taskProjections = new Map<string, any>();
  /** Background authority checks may join one in-flight read for this Team. */
  private readonly taskProjectionReads = new Map<string, Promise<TaskProjectionReadResult>>();
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
  pending(sessionId: string): CoordinationPendingObservation<CoordinationSyncResult> | undefined { const pending = this.pendingBySession.get(sessionId); return pending ? { sessionId: pending.sessionId, toolCallId: pending.toolCallId, resultText: pending.resultText, resultDigest: pending.resultDigest, head: pending.head, epochId: pending.epochId, baselineCursor: pending.baselineCursor, baselineAcknowledgedEntryId: pending.baselineAcknowledgedEntryId, result: pending.internalResult } : undefined; }
  stagedResult(sessionId: string): CoordinationSyncResult | undefined { return this.pendingBySession.get(sessionId)?.internalResult; }
  setPendingResult(sessionId: string, result: unknown): void { const pending = this.pendingBySession.get(sessionId); if (pending) { pending.resultText = JSON.stringify(result); pending.resultDigest = ""; } }
  clearPending(sessionId: string): void { this.pendingBySession.delete(sessionId); }
  discardPending(sessionId: string, toolCallId: string): void { if (this.pendingBySession.get(sessionId)?.toolCallId === toolCallId) this.pendingBySession.delete(sessionId); }
  takePending(sessionId: string): any { return this.pendingBySession.get(sessionId); }
  storeStage(sessionId: string, observation: any): void { this.pendingBySession.set(sessionId, { ...observation, ...(observation.taskProjection ? { taskProjection: structuredClone(observation.taskProjection) } : {}) }); }
  private taskProjectionKey(teamName: string, epochId: string, exactSessionId: string): string { return JSON.stringify([teamName, epochId, exactSessionId]); }
  private cachedTaskProjection(teamName: string, epochId: string, exactSessionId: string, acknowledgedEntryId: string, acknowledgedLineage: readonly string[], teamEventCursor: string): TaskProjection | undefined { const cached = this.taskProjections.get(this.taskProjectionKey(teamName, epochId, exactSessionId)); if (!cached || cached.acknowledgedEntryId !== acknowledgedEntryId || cached.teamEventCursor !== teamEventCursor || JSON.stringify(cached.acknowledgedLineage) !== JSON.stringify(acknowledgedLineage)) return undefined; return structuredClone(cached.projection); }
  private cacheTaskProjection(cache: any): void { this.taskProjections.set(this.taskProjectionKey(cache.teamName, cache.epochId, cache.exactSessionId), { ...cache, acknowledgedLineage: [...cache.acknowledgedLineage], projection: structuredClone(cache.projection) }); }
  async readSnapshot(exactSessionFile: string, context?: CoordinationObservationContext): Promise<CoordinationSnapshotResult> { const bound = await this.boundTeam(exactSessionFile); if (!bound) return { kind: "no_active_team" }; return this.readSnapshotForBound(bound, context); }
  private async readSnapshotForBound(bound: BoundTeam, context?: CoordinationObservationContext, fresh = true): Promise<CoordinationSnapshotResult> { const tasks = await (fresh ? this.readTaskProjectionFresh(bound.teamName) : this.readTaskProjection(bound.teamName)); if (tasks.kind !== "tasks") return tasks; const workers = this.readWorkers(bound, tasks.tasks); const leader = [...bound.config.members].reverse().find((member) => member.name === "team-lead"); const settings = loadWorkerResourcePolicy({ cwd: context?.cwd ?? leader?.cwd ?? process.cwd(), projectTrusted: context?.projectTrusted === true }).modelRoleSettings;
    const modelRoles = Object.entries(settings.roles).sort(([a], [b]) => a.localeCompare(b)).map(([name, role]) => ({ name, use: role.use })); return { kind: "snapshot", team: currentTeam(bound.config), modelRoles, ...(settings.defaultRole ? { defaultModelRole: settings.defaultRole } : {}), workers, tasks: tasks.tasks, ...(tasks.warnings.length ? { taskProjectionWarnings: tasks.warnings } : {}) }; }
  async acknowledge(exactSessionFile: string, entryId: string, branchIds: string[]): Promise<boolean> {
    const pending = this.takePending(exactSessionFile);
    if (!pending) return false;
    // Presentation consumes the staged result even if the baseline commit fails.
    this.discardPending(exactSessionFile, pending.toolCallId);
    if (!branchIds.includes(entryId)) return false;
    const current = await this.boundTeam(exactSessionFile);
    if (!current || current.teamName !== pending.teamName || current.config.epochId !== pending.epochId || this.leaderMembershipId(current) !== pending.leaderMembershipId) return false;
    const committed = await this.store.commitHidden(pending.teamName, { teamEpochId: pending.epochId, exactSessionId: pending.sessionId, branchLineage: branchIds, acknowledgedEntryId: entryId, teamEventCursor: String(pending.head), authorityRevisions: pending.authorityRevisions });
    if (committed.kind !== "committed") return false;
    if (pending.taskProjection) this.cacheTaskProjection({ teamName: pending.teamName, epochId: pending.epochId, exactSessionId: pending.sessionId, acknowledgedEntryId: committed.projection.acknowledgedEntryId, acknowledgedLineage: [...committed.projection.acknowledgedLineage], teamEventCursor: committed.projection.teamEventCursor, projection: pending.taskProjection });
    return true;
  }
  private leaderMembershipId(bound: BoundTeam): string | undefined { return [...bound.config.members].reverse().find((member) => member.name === "team-lead" && member.agentType === "lead" && member.isActive !== false && member.sessionFile === bound.sessionFile)?.membershipId; }
  private async bindingStillCurrent(bound: BoundTeam): Promise<boolean> { const current = await this.boundTeam(bound.sessionFile); return !!current && current.teamName === bound.teamName && current.config.epochId === bound.config.epochId && this.leaderMembershipId(current) === this.leaderMembershipId(bound); }
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
    if (!this.nudgeDebt || !bound || !policy || !(policy.autoSyncEnabled ?? policy.nudgeEnabled ?? true)) return { kind: "none" };
    return this.nudgeDebt.read({
      teamName: bound.teamName,
      sessionFile: bound.sessionFile,
      config: { ...bound.config, syncLiveness: { waitSeconds: policy.waitSeconds, autoSyncEnabled: policy.autoSyncEnabled, nudgeEnabled: policy.nudgeEnabled, policyVersion: policy.policyVersion } },
    }, branchLineage);
  }
  async readTeamSync(
    exactSessionFile: string,
    view: "snapshot" | "updates",
    signal: AbortSignal,
    toolCallId: string,
    context?: CoordinationObservationContext,
  ): Promise<CoordinationSyncResult> {
    return this.runSelectedObservation(exactSessionFile, view, signal, toolCallId, context, "wait") as Promise<CoordinationSyncResult>;
  }

  async readTeamSyncNow(
    exactSessionFile: string,
    view: "snapshot" | "updates",
    signal: AbortSignal,
    toolCallId: string,
    context?: CoordinationObservationContext,
  ): Promise<CoordinationSyncNowResult> {
    return this.runSelectedObservation(exactSessionFile, view, signal, toolCallId, context, "now");
  }

  private async runSelectedObservation(
    exactSessionFile: string,
    view: "snapshot" | "updates",
    signal: AbortSignal,
    toolCallId: string,
    context: CoordinationObservationContext | undefined,
    mode: "wait" | "now",
  ): Promise<CoordinationSyncNowResult> {
    const pending = this.pendingBySession.get(exactSessionFile);
    if (pending?.toolCallId === toolCallId) return pending.internalResult;
    if (pending || this.inFlightBySession.has(exactSessionFile)) return { kind: "refused", reason: "observation_in_progress", message: "Another team_sync call in this message owns the observation. Use its result." };
    this.inFlightBySession.add(exactSessionFile);
    try {
      return await this.readTeamSyncInternal(exactSessionFile, view, signal, toolCallId, context, mode, true);
    } finally {
      this.inFlightBySession.delete(exactSessionFile);
    }
  }

  /** Read one canonical observation for scheduling. No result or cursor is staged. */
  async peekTeamSync(exactSessionFile: string, view: "snapshot" | "updates", branchLineage: string[]): Promise<CoordinationSyncProbe> {
    if (this.inFlightBySession.has(exactSessionFile) || this.pendingBySession.has(exactSessionFile)) {
      return { kind: "indeterminate", message: "A Team observation is already in progress for this exact Session." };
    }
    const before = await this.probeScope(exactSessionFile, branchLineage);
    if (before.kind !== "scope") return before;
    let selectedPage: ReturnType<CoordinationObservationStore["readEvents"]> | undefined;
    let laterExternalEvidence = false;
    const result = await this.readTeamSyncInternal(exactSessionFile, view, new AbortController().signal, "probe", undefined, "now", false, branchLineage, (page, laterPages) => {
      selectedPage = page;
      laterExternalEvidence = laterPages.some((later) => later.events.some((event) => event.type !== "task" || event.actor !== "team-lead"));
    });
    const after = await this.probeScope(exactSessionFile, branchLineage);
    if (after.kind !== "scope" || after.scopeKey !== before.scopeKey) {
      return { kind: "indeterminate", message: "The Team observation binding changed during the probe." };
    }
    if (result.kind === "quiet" || result.kind === "caught_up") return { kind: "quiet", updateCount: 0, scopeKey: before.scopeKey };
    if (result.kind === "snapshot") {
      const updateCount = result.workers.length + result.tasks.length;
      return updateCount > 0
        ? { kind: "prepared", result, updateCount, scopeKey: before.scopeKey }
        : { kind: "quiet", updateCount: 0, scopeKey: before.scopeKey };
    }
    if (result.kind === "updates") {
      const updateCount = this.eligibleProbeCount(selectedPage?.events ?? [], result);
      const continuationEligible = updateCount === 0 && this.visibleUpdateCount(result) > 0 && laterExternalEvidence;
      return updateCount > 0 || continuationEligible
        ? { kind: "prepared", result, updateCount, scopeKey: before.scopeKey, ...(continuationEligible ? { continuationEligible: true as const } : {}) }
        : { kind: "quiet", updateCount: 0, scopeKey: before.scopeKey };
    }
    if (result.kind === "unsettled") return { kind: "indeterminate", message: "Worker evidence is incomplete." };
    if (result.kind === "cancelled") return { kind: "indeterminate", message: result.message };
    return result;
  }

  /** Choose the baseline form without reading a canonical Team projection. */
  async selectTeamSyncView(exactSessionFile: string, branchLineage: string[]): Promise<"snapshot" | "updates"> {
    const bound = await this.boundTeam(exactSessionFile);
    if (!bound) return "snapshot";
    const hidden = await this.store.readHidden(bound.teamName, { teamEpochId: bound.config.epochId!, exactSessionId: exactSessionFile, branchLineage });
    return hidden.kind === "found" ? "updates" : "snapshot";
  }

  private async probeScope(exactSessionFile: string, branchLineage: string[]): Promise<{ kind: "scope"; scopeKey: string; teamName: string; baselineCursor: string } | Extract<CoordinationSyncProbe, { kind: "unavailable" | "contract_gap" }>> {
    const bound = await this.boundTeam(exactSessionFile);
    if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    const lead = [...bound.config.members].reverse().find((member) => member.name === "team-lead" && member.agentType === "lead" && member.isActive !== false && member.sessionFile === exactSessionFile);
    if (!lead?.membershipId) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Membership is no longer current." };
    const hidden = await this.store.readHidden(bound.teamName, { teamEpochId: bound.config.epochId!, exactSessionId: exactSessionFile, branchLineage });
    if (hidden.kind === "contract_gap") return { kind: "contract_gap", reason: hidden.reason, message: `Model-tool ${hidden.reason.replaceAll("_", " ")} is unavailable.` };
    const baseline = hidden.kind === "found" ? hidden.projection : undefined;
    const acknowledged = baseline?.acknowledgedLineage ?? [];
    // The first post-acknowledgement descendant separates sibling branches.
    // Later descendants do not reset a batch's first-unseen deadline.
    const branchSide = branchLineage.slice(0, acknowledged.length + 1);
    return { kind: "scope", teamName: bound.teamName, baselineCursor: baseline?.teamEventCursor ?? "0", scopeKey: JSON.stringify([bound.teamName, bound.config.epochId, lead.membershipId, exactSessionFile, acknowledged, baseline?.acknowledgedEntryId ?? null, baseline?.teamEventCursor ?? null, baseline?.authorityRevisions ?? null, branchSide]) };
  }

  private visibleUpdateCount(result: Extract<CoordinationSyncResult, { kind: "updates" }>): number {
    return result.teamChanges.length + result.workerChanges.length + result.taskChanges.length + result.alerts.length;
  }

  private eligibleProbeCount(events: readonly TeamEvent[], result: Extract<CoordinationSyncResult, { kind: "updates" }>): number {
    const externalTaskIds = new Set<string>();
    const eventTaskIds = new Set<string>();
    for (const event of events) {
      if (event.type === "task") {
        eventTaskIds.add(event.ref.taskId);
        if (event.actor !== "team-lead") externalTaskIds.add(event.ref.taskId);
      }
    }
    return result.teamChanges.length + result.workerChanges.length + result.alerts.length
      + result.taskChanges.filter((change) => externalTaskIds.has(change.taskId) || !eventTaskIds.has(change.taskId)).length;
  }

  private readCurrentEventPages(teamName: string, afterCursor: string): Array<ReturnType<CoordinationObservationStore["readEvents"]>> {
    if (this.store.readEventPages) return this.store.readEventPages(teamName, { afterCursor });
    const pages = [this.store.readEvents(teamName, { afterCursor })];
    while (pages.at(-1)!.truncated) {
      const cursor = pages.at(-1)!.cursor;
      const page = this.store.readEvents(teamName, { afterCursor: cursor });
      if (page.cursor === cursor) throw new Error("Team observation pagination did not advance.");
      pages.push(page);
    }
    return pages;
  }

  private async readTeamSyncInternal(
    exactSessionFile: string,
    view: "snapshot" | "updates",
    signal: AbortSignal,
    toolCallId: string,
    context: CoordinationObservationContext | undefined,
    mode: "wait" | "now",
    publish: boolean,
    branchLineageOverride?: string[],
    onSelectedPage?: (page: ReturnType<CoordinationObservationStore["readEvents"]>, laterPages: Array<ReturnType<CoordinationObservationStore["readEvents"]>>) => void,
  ): Promise<CoordinationSyncNowResult> {
    if (signal.aborted) return { kind: "cancelled", message: "The updates wait was cancelled before an observation was published." };
    let bound = await this.boundTeam(exactSessionFile);
    if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    const pending = publish ? this.stagedResult(exactSessionFile) : undefined;
    if (pending !== undefined) return pending;
    const branchLineage = branchLineageOverride ?? this.branchContext(exactSessionFile);
    // A selected result must start an authority read after its call began.
    // It cannot join a background probe that started before a Task commit.
    const readTasks = (teamName: string) => publish ? this.readTaskProjectionFresh(teamName) : this.readTaskProjection(teamName);
    if (view === "updates") {
      const observation = await this.store.readHidden(bound.teamName, {
        teamEpochId: bound.config.epochId!,
        exactSessionId: bound.sessionFile,
        branchLineage,
      });
      if (observation.kind === "contract_gap") return { ...observation, message: `Model-tool ${observation.reason.replaceAll("_", " ")} is unavailable for Team ${bound.teamName}.` };
      if (observation.kind !== "found") {
        return this.readTeamSyncInternal(exactSessionFile, "snapshot", signal, toolCallId, context, mode, publish, branchLineageOverride);
      }
      // Read the event batch first. Task events identify the smallest authority
      // read needed for this update; Worker-only events do not read Tasks when a
      // baseline is bound to this exact Team, epoch, Session, branch, and cursor.
      let readCursor = observation.projection.teamEventCursor;
      const comparisonRevision = observation.projection.authorityRevisions.task_projection;
      for (;;) {
      const immediatePages = this.readCurrentEventPages(bound.teamName, readCursor);
      let batch = immediatePages.find(page => page.events.length > 0) ?? immediatePages.at(-1)!;
      let tasksResult: TaskProjection | undefined;
      let taskRevisionChanged = false;
      let externallyChangedTaskIds: string[] = [];
      if (batch.events.length === 0) {
        // A quiet journal cannot prove that an external Task writer did not
        // change state, so read the complete authority projection first.
        const complete = await readTasks(bound.teamName);
        if (complete.kind !== "tasks") return complete;
        tasksResult = complete;
        taskRevisionChanged = comparisonRevision !== taskProjectionRevision(tasksResult.tasks, tasksResult.warnings);
        if (!taskRevisionChanged) {
          const observations = await this.workerRunObservations(bound);
          const noChange = async (current: WorkerRunObservation[]): Promise<CoordinationSyncNowResult> => {
            if (signal.aborted) return { kind: "cancelled", message: "The updates wait was cancelled before an observation was published." };
            if (publish && !await this.bindingStillCurrent(bound!)) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session no longer owns this Team observation." };
            if (mode === "now") return { kind: "quiet" };
            const workers: Extract<CoordinationSyncResult, { kind: "unsettled" }>["workers"] = current.flatMap<Extract<CoordinationSyncResult, { kind: "unsettled" }>["workers"][number]>((item) => {
              if (item.state === "active") return [{ name: item.worker, reason: "still_active" as const }];
              if (item.actuationPending) return [{ name: item.worker, reason: "actuation_pending" as const }];
              return item.state === "unknown" ? (item.unknownReasons ?? ["run_state_unknown" as const]).map(reason => ({ name: item.worker, reason })) : [];
            });
            const result: Extract<CoordinationSyncResult, { kind: "caught_up" | "unsettled" }> = workers.length
              ? { kind: "unsettled", head: asNumber(batch.cursor), epochId: bound!.config.epochId!, workers }
              : { kind: "caught_up", head: asNumber(batch.cursor), epochId: bound!.config.epochId! };
            if (publish) this.stage(exactSessionFile, bound!.sessionFile, toolCallId, result, result.head, result.epochId, bound!.teamName, view, {
              team_events: String(result.head),
              task_projection: taskProjectionRevision(tasksResult!.tasks, tasksResult!.warnings),
              task_event_failure_hints: this.taskEventFailureHintCursor(bound!.teamName, result.epochId, tasksResult!.tasks, observation.projection.authorityRevisions.task_event_failure_hints ?? "0"),
            }, tasksResult, this.leaderMembershipId(bound!), { cursor: observation.projection.teamEventCursor, acknowledgedEntryId: observation.projection.acknowledgedEntryId });
            return result;
          };
          if (livenessIsComplete(observations)) {
            // Absent Memberships retain the hardened eventless Task rescan.
            const allAbsent = observations.length > 0 && observations.every(item => item.state === "absent");
            if (allAbsent) {
              try {
                batch = await this.store.waitEvents({ teamName: bound.teamName, afterCursor: readCursor, waitMs: 0, signal });
                const beforeWait = tasksResult;
                const rechecked = await readTasks(bound.teamName);
                if (rechecked.kind !== "tasks") return rechecked;
                tasksResult = rechecked;
                externallyChangedTaskIds = this.changedTaskIds(beforeWait, rechecked);
                taskRevisionChanged = comparisonRevision !== taskProjectionRevision(tasksResult.tasks, tasksResult.warnings);
              } catch (error) {
                if (isAbort(error)) return { kind: "cancelled", message: "The updates wait was cancelled before an observation was published." };
                throw error;
              }
            }
            if (batch.events.length === 0 && !taskRevisionChanged) return noChange(observations);
          }
          if (!livenessIsProductive(observations) && !(batch.events.length > 0 || taskRevisionChanged)) {
            if (mode === "now") return { kind: "indeterminate", message: "Worker run-state evidence is incomplete; no observation was published." };
            return noChange(observations);
          }
          if (batch.events.length === 0 && !taskRevisionChanged) {
            if (mode === "now") return { kind: "quiet" };
            try {
              const waitMs = Math.max(0, (bound.config.syncLiveness?.waitSeconds ?? DEFAULT_SYNC_WAIT_SECONDS) * 1000);
              let priorObservations = observations;
              const originalTeam = bound.teamName;
              const originalEpoch = bound.config.epochId;
              const originalLead = [...bound.config.members].reverse().find((member) => member.name === "team-lead" && member.agentType === "lead" && member.isActive !== false && member.sessionFile === exactSessionFile)?.membershipId;
              const producerHint = async (): Promise<boolean> => {
                const next = this.store.readEvents(bound!.teamName, { afterCursor: readCursor });
                if (next.events.length > 0) return true;
                const latest = await this.boundTeam(exactSessionFile);
                if (!latest || latest.teamName !== originalTeam || latest.config.epochId !== originalEpoch) return true;
                const current = await this.workerRunObservations(latest);
                return current.length !== priorObservations.length || current.some((item, index) => item.state !== priorObservations[index]?.state || item.actuationPending !== priorObservations[index]?.actuationPending || item.membershipId !== priorObservations[index]?.membershipId || JSON.stringify(item.generation) !== JSON.stringify(priorObservations[index]?.generation) || JSON.stringify(item.unknownReasons) !== JSON.stringify(priorObservations[index]?.unknownReasons));
              };
              const authorityHint = async (): Promise<boolean> => {
                if (await producerHint()) return true;
                const currentTasks = await readTasks(bound!.teamName);
                return currentTasks.kind === "tasks" && comparisonRevision !== taskProjectionRevision(currentTasks.tasks, currentTasks.warnings);
              };
              for (;;) {
                // Zero means one immediate recheck. A positive interval is only an
                // internal watcher deadline while a current Worker remains active.
                const waitOutcome = await this.wait.waitForLivenessHint({ teamName: bound.teamName, waitMs, signal, authorityCheckMs: 5_000, check: producerHint, checkAuthority: authorityHint });
                if (signal.aborted) return { kind: "cancelled", message: "The updates wait was cancelled before an observation was published." };
                const latest = await this.boundTeam(exactSessionFile);
                const latestLead = latest && [...latest.config.members].reverse().find((member) => member.name === "team-lead" && member.agentType === "lead" && member.isActive !== false && member.sessionFile === exactSessionFile)?.membershipId;
                if (!latest || latest.teamName !== originalTeam || latest.config.epochId !== originalEpoch || latestLead !== originalLead) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session no longer owns this Team observation." };
                bound = latest;
                batch = this.store.readEvents(bound.teamName, { afterCursor: readCursor });
                const beforeWait = tasksResult;
                const rechecked = await readTasks(bound.teamName);
                if (rechecked.kind !== "tasks") return rechecked;
                tasksResult = rechecked;
                externallyChangedTaskIds = beforeWait ? this.changedTaskIds(beforeWait, rechecked) : [];
                taskRevisionChanged = comparisonRevision !== taskProjectionRevision(tasksResult.tasks, tasksResult.warnings);
                if (batch.events.length === 0 && !taskRevisionChanged) {
                  const afterWait = await this.workerRunObservations(bound);
                  if (livenessIsComplete(afterWait)) return noChange(afterWait);
                  const evidenceChanged = JSON.stringify(afterWait) !== JSON.stringify(priorObservations);
                  if (waitMs === 0 || (!afterWait.some((item) => item.state === "active") && (!afterWait.some((item) => item.actuationPending) || (waitOutcome === "timeout" && !evidenceChanged)))) return noChange(afterWait);
                  priorObservations = afterWait;
                  continue;
                }
                break;
              }
            } catch (error) {
              if (isAbort(error)) return { kind: "cancelled", message: "The updates wait was cancelled before an observation was published." };
              throw error;
            }
          }
        }
      }

      const candidatePages = immediatePages.includes(batch) ? immediatePages.slice(immediatePages.indexOf(batch)) : [batch];
      for (let pageIndex = 0; pageIndex < candidatePages.length; pageIndex++) {
        batch = candidatePages[pageIndex];
        if (batch.events.length > 0) {
          const completeTaskSet = this.coordinationQueries.taskStateDelivery.completeTaskSet?.(bound.teamName) === true;
          if (completeTaskSet) {
            // Graph authority owns a complete current set. Rescan it before
            // projecting historical events, so removed IDs are subtracted and
            // are never hydrated as if they were current authority gaps.
            const current = await readTasks(bound.teamName);
            if (current.kind !== "tasks") return current;
            tasksResult = current;
          } else {
            const baseline = tasksResult ?? this.cachedProjectionForBound(bound, observation.projection);
            if (!baseline) {
              // A restarted port has no memory cache. A complete authority rescan
              // is the safe recovery path; it is never merged from another branch.
              const recovered = await readTasks(bound.teamName);
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
        }
        if (!tasksResult) {
          throw new Error("Task authority did not produce a complete Team observation.");
        }
        const projected = await this.projectUpdates(bound, batch.events, observation.projection, tasksResult.tasks, taskRevisionChanged, tasksResult.warnings, externallyChangedTaskIds);
        if (projected.kind !== "updates") return projected;
        if (signal.aborted) return { kind: "cancelled", message: "The updates wait was cancelled before an observation was published." };
        if (this.visibleUpdateCount(projected) === 0) {
          // A pure removal has no current Task card for the eventless rescan.
          // Present the complete empty set rather than consume an unseen revision.
          if (mode === "wait" && batch.events.length === 0 && taskRevisionChanged && tasksResult.tasks.length === 0) {
            return this.readTeamSyncInternal(exactSessionFile, "snapshot", signal, toolCallId, context, mode, publish, branchLineageOverride);
          }
          continue;
        }
        if (publish && !await this.bindingStillCurrent(bound)) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session no longer owns this Team observation." };
        // The page cursor is the last event represented in this result. The
        // journal head may include later pages that have not been projected.
        const pageCursor = asNumber(batch.cursor);
        projected.head = pageCursor;
        if (publish) this.stage(exactSessionFile, bound.sessionFile, toolCallId, projected, pageCursor, bound.config.epochId!, bound.teamName, view, {
          team_events: String(pageCursor),
          task_projection: taskProjectionRevision(tasksResult.tasks, tasksResult.warnings),
          task_event_failure_hints: this.taskEventFailureHintCursor(bound.teamName, bound.config.epochId!, tasksResult.tasks, observation.projection.authorityRevisions.task_event_failure_hints ?? "0"),
        }, tasksResult, this.leaderMembershipId(bound), { cursor: observation.projection.teamEventCursor, acknowledgedEntryId: observation.projection.acknowledgedEntryId });
        onSelectedPage?.(batch, candidatePages.slice(pageIndex + 1));
        return projected;
      }
      if (mode === "now") return { kind: "quiet" };
      if (batch.events.length > 0 && batch.cursor === readCursor) throw new Error("Team observation pagination did not advance.");
      readCursor = batch.cursor;
      }
    }
    const snapshot = await this.readSnapshotForBound(bound, context, publish);
    if (signal.aborted) return { kind: "cancelled", message: "The updates wait was cancelled before an observation was published." };
    if (snapshot.kind !== "snapshot") {
      if (snapshot.kind === "contract_gap" || snapshot.kind === "unavailable") return snapshot;
      return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
    }
    if (publish && !await this.bindingStillCurrent(bound)) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session no longer owns this Team observation." };
    const head = this.store.readEventCursor(bound.teamName);
    const result: Extract<CoordinationSyncResult, { kind: "snapshot" }> = { ...snapshot, head: asNumber(head), epochId: bound.config.epochId! };
    if (mode === "now" && result.workers.length === 0 && result.tasks.length === 0) return { kind: "quiet" };
    if (publish) this.stage(exactSessionFile, bound.sessionFile, toolCallId, result, asNumber(head), bound.config.epochId!, bound.teamName, view, {
      team_events: String(asNumber(head)),
      task_projection: taskProjectionRevision(result.tasks, result.taskProjectionWarnings),
      task_event_failure_hints: this.taskEventFailureHintCursor(bound.teamName, bound.config.epochId!, result.tasks, "0"),
    }, { tasks: result.tasks, warnings: result.taskProjectionWarnings ?? [] }, this.leaderMembershipId(bound), { cursor: null, acknowledgedEntryId: null });
    return result;
  }

  private taskEventFailureHintCursor(teamName: string, teamEpochId: string, tasks: readonly CanonicalTaskCard[], afterCursor: string): string {
    return this.store.readFailureHints(teamName, afterCursor, {
      teamEpochId,
      taskReferences: tasks.map((task) => ({ taskId: task.id, taskVersion: taskVersionRef(task.version) })),
    }).headCursor;
  }

  async readTaskProjection(teamName: string): Promise<TaskProjectionReadResult> {
    const current = this.taskProjectionReads.get(teamName);
    if (current) return current;
    const read = this.readTaskProjectionOnce(teamName);
    this.taskProjectionReads.set(teamName, read);
    try {
      return await read;
    } finally {
      if (this.taskProjectionReads.get(teamName) === read) this.taskProjectionReads.delete(teamName);
    }
  }

  private readTaskProjectionFresh(teamName: string): Promise<TaskProjectionReadResult> {
    return this.readTaskProjectionOnce(teamName);
  }

  private async readTaskProjectionOnce(teamName: string): Promise<TaskProjectionReadResult> {
    try {
      const taskIds = await this.coordinationQueries.taskStateDelivery.listTaskIds(teamName);
      const records = await this.coordinationQueries.taskStateDelivery.readTasks(teamName, taskIds);
      this.assertCompleteTaskBatch(taskIds, records, "listed Task");
      const projected: CanonicalTaskCard[] = [];
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

  private currentTaskEvents(events: readonly TeamEvent[], tasks: readonly CanonicalTaskCard[]): TeamEvent[] {
    const currentById = new Map(tasks.map((task) => [task.id, task.version]));
    return events.filter((event) => event.type !== "task"
      || currentById.get(event.ref.taskId) === event.ref.version);
  }

  private readWorkers(bound: BoundTeam, taskProjection: CanonicalTaskCard[]): Array<CoordinationWorkerCurrent & { nonterminalTaskIds: string[] }> {
    return (bound.config.logicalWorkers ?? []).map((logical) => {
      const member = latestMember(bound.config, logical.name);
      return {
        name: logical.name,
        scope: logical.scope,
        carrier: workerCarrier(member),
        ...(logical.modelProfile?.alias ? { modelRole: logical.modelProfile.alias } : {}),
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

  private async projectUpdates(bound: BoundTeam, events: TeamEvent[], observation: CoordinationHiddenObservationProjection, taskProjection?: CanonicalTaskCard[], taskRevisionChanged = false, taskWarnings: TaskCardWarning[] = [], externallyChangedTaskIds: readonly string[] = []): Promise<Extract<CoordinationSyncResult, { kind: "updates" | "contract_gap" | "unavailable" }>> {
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
      ? this.projection.projectTaskChanges(this.currentTaskEvents(events, taskResult.tasks), taskResult.tasks)
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

  private stage(sessionId: string, exactSessionFile: string, toolCallId: string, result: CoordinationSyncResult, head: number, epochId: string, teamName: string, view: "snapshot" | "updates", authorityRevisions: Record<string, string> = { team_events: String(head) }, taskProjection?: TaskProjection, leaderMembershipId?: string, baseline?: { cursor: string | null; acknowledgedEntryId: string | null }): void {
    this.storeStage(sessionId, {
      sessionId: exactSessionFile,
      toolCallId,
      resultText: "",
      resultDigest: "",
      head,
      epochId,
      leaderMembershipId,
      baselineCursor: baseline?.cursor,
      baselineAcknowledgedEntryId: baseline?.acknowledgedEntryId,
      internalResult: result,
      teamName,
      view,
      authorityRevisions,
      ...(taskProjection ? { taskProjection: structuredClone(taskProjection) } : {}),
    });
  }
}
