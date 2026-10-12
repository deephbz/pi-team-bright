import * as teamEvents from "./event-journal";
import { deriveWorkerRunObservation, type WorkerRunObservation } from "../utils/sync-liveness";
import { hostEnv, type TimerHandle } from "../env/host-env";
import type { CanonicalTaskCard, TaskCardWarning } from "../task-authority/task-domain";
import type { TeamEvent } from "./contracts";
import type { CoordinationQueryBundle, CoordinationLeaderBindingEvidence } from "./queries";
import { CoordinationNudgeDebtService, type SyncNudgeDebt } from "./nudge-debt";
import { taskProjectionRevision } from "./task-projection-revision";
import { readBranchObservation, type BranchEntry, type BranchObservation, type ObservationStamp } from "./branch-observation";
import { loadWorkerResourcePolicy } from "../utils/worker-resource-projection";
import type { CoordinationPendingObservation, CoordinationSnapshotResult, CoordinationSyncResult, CoordinationSyncNowResult, CoordinationSyncProbe, CoordinationTaskProjection, CoordinationWorkerCurrent } from "./observation-contracts";
export { taskProjectionRevision } from "./task-projection-revision";

type TaskProjection = CoordinationTaskProjection;
type TaskRead = ({ kind: "tasks" } & TaskProjection) | Extract<CoordinationSyncResult, { kind: "contract_gap" | "unavailable" }>;
type BoundTeam = { teamName: string; config: CoordinationLeaderBindingEvidence & { epochId: string }; sessionFile: string; membershipId: string };
type Page = ReturnType<typeof teamEvents.readTeamEvents>;
export interface CoordinationProjectionDependencies {
  projectNonterminalTaskIds(tasks: readonly CanonicalTaskCard[], workerName: string): string[];
  projectTaskChanges(events: readonly TeamEvent[], tasks: readonly CanonicalTaskCard[]): { kind: "projected"; changes: Array<{ taskId: string; changeKinds: Array<"created" | "goal" | "assignment" | "progress" | "status" | "relation">; journalEntries: import("../task-authority/contracts").ModelToolTaskJournalEntry[]; current: CanonicalTaskCard }> } | Extract<CoordinationSyncResult, { kind: "contract_gap" }>;
}
export interface CoordinationObservationContext { cwd?: string; projectTrusted?: boolean }
export interface CoordinationObservationStore {
  readEvents: typeof teamEvents.readTeamEvents;
  readEventPages?: typeof teamEvents.readTeamEventPages;
  readEventCursor: typeof teamEvents.readTeamEventCursor;
}
export function createDurableCoordinationObservationStore(): CoordinationObservationStore {
  return { readEvents: teamEvents.readTeamEvents, readEventPages: teamEvents.readTeamEventPages, readEventCursor: teamEvents.readTeamEventCursor };
}
interface Reservation {
  toolCallId: string;
  branch: string[];
  timer: TimerHandle;
  stamp?: ObservationStamp;
  result?: CoordinationSyncResult;
  resultText: string;
}
export const OBSERVATION_RESERVATION_MS = 30_000;

/** The Session supplies its selected native branch. No reader position is written outside it. */
export class CoordinationObservationService {
  private readonly branches = new Map<string, BranchEntry[]>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly taskProjectionReads = new Map<string, Promise<TaskRead>>();
  private readonly nudgeDebt = new CoordinationNudgeDebtService(this);
  constructor(private readonly coordinationQueries: CoordinationQueryBundle, private readonly projection: CoordinationProjectionDependencies, private readonly store: CoordinationObservationStore) {}

  setBranchEntries(session: string, entries: BranchEntry[]): void {
    this.branches.set(session, [...entries]);
    const held = this.reservations.get(session);
    if (!held) return;
    const persisted = held.stamp && readBranchObservation(entries, held.stamp);
    if ((persisted && Number(persisted.cursor) >= held.stamp!.through && !held.branch.includes(persisted.entryId))
      || held.branch.some((id, index) => entries[index]?.id !== id)) this.clearPending(session);
  }
  setBranchContext(session: string, ids: string[]): void {
    const existing = this.branches.get(session) ?? [];
    this.setBranchEntries(session, ids.map(id => existing.find(entry => entry.id === id) ?? { id, type: "unknown" }));
  }
  branchContext(session: string): string[] { return (this.branches.get(session) ?? []).map(entry => entry.id); }
  clearPending(session: string): void {
    const held = this.reservations.get(session);
    if (held) hostEnv().clock.clearTimeout(held.timer);
    this.reservations.delete(session);
  }
  discardPending(session: string, call: string): void { if (this.reservations.get(session)?.toolCallId === call) this.clearPending(session); }
  setPendingResult(session: string, result: unknown): void { const held = this.reservations.get(session); if (held) held.resultText = JSON.stringify(result); }
  pending(session: string): CoordinationPendingObservation<CoordinationSyncResult> | undefined {
    const held = this.reservations.get(session);
    if (!held?.result || !held.stamp) return undefined;
    return { sessionId: session, toolCallId: held.toolCallId, resultText: held.resultText, resultDigest: "", head: held.stamp.through, epochId: held.stamp.epoch, observation: held.stamp, result: held.result };
  }
  private async boundTeam(file: string): Promise<BoundTeam | undefined> {
    const config = await this.coordinationQueries.teamRuntime.readLeaderBinding?.(file);
    const lead = config?.members.find(member => member.name === "team-lead" && member.agentType === "lead" && member.isActive !== false && member.sessionFile === file);
    if (!config?.epochId || !config.logicalWorkers || !lead?.membershipId) return undefined;
    return { teamName: config.teamName, config: config as BoundTeam["config"], sessionFile: file, membershipId: lead.membershipId };
  }
  private baseline(bound: BoundTeam, ids?: string[]): BranchObservation | undefined {
    const branch = this.branches.get(bound.sessionFile) ?? [];
    return readBranchObservation(ids ? branch.filter(entry => ids.includes(entry.id)) : branch, { team: bound.teamName, epoch: bound.config.epochId, binding: bound.membershipId });
  }
  async selectTeamSyncView(file: string, ids: string[]): Promise<"snapshot" | "updates"> {
    const bound = await this.boundTeam(file);
    return bound && this.baseline(bound, ids) ? "updates" : "snapshot";
  }
  async readSyncNudgeDebt(file: string, ids: string[]): Promise<SyncNudgeDebt> {
    const config = await this.coordinationQueries.teamRuntime.readLeaderBinding?.(file);
    if (!config?.members.some(member => member.name === "team-lead" && member.agentType === "lead" && member.isActive !== false && member.sessionFile === file)) return { kind: "none" };
    if (config.epochId && !config.logicalWorkers) return { kind: "unavailable", message: "Model-tool logical workers missing is unavailable." };
    const bound = await this.boundTeam(file);
    if (!bound?.config.syncLiveness) return { kind: "none" };
    return this.nudgeDebt.read({ ...bound, config: { ...bound.config, syncLiveness: bound.config.syncLiveness } }, ids);
  }
  async readSnapshot(file: string, context?: CoordinationObservationContext): Promise<CoordinationSnapshotResult> {
    const bound = await this.boundTeam(file);
    return bound ? this.snapshot(bound, context) : { kind: "no_active_team" };
  }
  private async snapshot(bound: BoundTeam, context?: CoordinationObservationContext): Promise<CoordinationSnapshotResult> {
    const tasks = await this.readTaskProjectionOnce(bound.teamName);
    if (tasks.kind !== "tasks") return tasks;
    const leader = bound.config.members.find(member => member.name === "team-lead");
    const settings = loadWorkerResourcePolicy({ cwd: context?.cwd ?? leader?.cwd ?? hostEnv().process.cwd(), projectTrusted: context?.projectTrusted === true }).modelRoleSettings;
    return { kind: "snapshot", team: { name: bound.teamName, purpose: bound.config.purpose ?? "", lifecycle: "active" },
      modelRoles: Object.entries(settings.roles).sort(([a], [b]) => a.localeCompare(b)).map(([name, role]) => ({ name, use: role.use })),
      ...(settings.defaultRole ? { defaultModelRole: settings.defaultRole } : {}), workers: this.readWorkers(bound, tasks.tasks), tasks: tasks.tasks,
      ...(tasks.warnings.length ? { taskProjectionWarnings: tasks.warnings } : {}) };
  }
  async readTeamSync(file: string, view: "snapshot" | "updates", signal: AbortSignal, call: string, context?: CoordinationObservationContext): Promise<CoordinationSyncResult> {
    return this.selected(file, view, signal, call, context, false) as Promise<CoordinationSyncResult>;
  }
  async readTeamSyncNow(file: string, view: "snapshot" | "updates", signal: AbortSignal, call: string, context?: CoordinationObservationContext): Promise<CoordinationSyncNowResult> {
    return this.selected(file, view, signal, call, context, true);
  }
  private async selected(file: string, view: "snapshot" | "updates", signal: AbortSignal, call: string, context: CoordinationObservationContext | undefined, automatic: boolean): Promise<CoordinationSyncNowResult> {
    if (signal.aborted) return { kind: "cancelled", message: "The observation was cancelled before native persistence." };
    const current = this.reservations.get(file);
    if (current) {
      const bound = await this.boundTeam(file);
      if (current.stamp && (!bound || current.stamp.binding !== bound.membershipId || current.stamp.epoch !== bound.config.epochId || current.stamp.team !== bound.teamName)) this.clearPending(file);
      else return { kind: "refused", reason: "observation_in_progress", message: "Another Team observation owns this page. End the turn and use its result." };
    }
    // Reserve before the first authority await. Expiry releases ownership only.
    const held: Reservation = { toolCallId: call, branch: this.branchContext(file), resultText: "", timer: hostEnv().clock.setTimeout(() => { if (this.reservations.get(file) === held) this.clearPending(file); }, OBSERVATION_RESERVATION_MS) };
    (held.timer as { unref?: () => void }).unref?.();
    this.reservations.set(file, held);
    try {
      const bound = await this.boundTeam(file);
      if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "The exact leader Session is not bound to an active Team." };
      const baseline = this.baseline(bound);
      held.stamp = { team: bound.teamName, epoch: bound.config.epochId, binding: bound.membershipId, from: Number(baseline?.cursor ?? 0), through: Number(baseline?.cursor ?? 0) };
      const result = await this.observe(bound, view, baseline, context, automatic);
      const latest = await this.boundTeam(file);
      if (signal.aborted || this.reservations.get(file) !== held || held.branch.some((id, index) => this.branchContext(file)[index] !== id)) return { kind: "cancelled", message: "The observation was cancelled before native persistence." };
      if (!latest || latest.membershipId !== bound.membershipId || latest.config.epochId !== bound.config.epochId || latest.teamName !== bound.teamName) return { kind: "unavailable", reason: "no_active_team", message: "The leader binding changed during observation." };
      if ("head" in result) { held.stamp.through = result.head; held.result = result; }
      return result;
    } finally { if (!held.result && this.reservations.get(file) === held) this.clearPending(file); }
  }
  private pages(team: string, since: string): Page[] {
    if (this.store.readEventPages) return this.store.readEventPages(team, { afterCursor: since });
    const pages = [this.store.readEvents(team, { afterCursor: since })];
    while (pages.at(-1)!.truncated) {
      const cursor = pages.at(-1)!.cursor;
      const next = this.store.readEvents(team, { afterCursor: cursor });
      if (next.cursor === cursor) throw new Error("Team observation pagination did not advance.");
      pages.push(next);
    }
    return pages;
  }
  private async observe(bound: BoundTeam, view: "snapshot" | "updates", baseline: BranchObservation | undefined, context?: CoordinationObservationContext, automatic = false, selected?: (page: Page, later: Page[]) => void): Promise<CoordinationSyncNowResult> {
    if (view === "snapshot" || !baseline) {
      // Capture the journal boundary before any Task authority hydration.
      const head = Number(this.store.readEventCursor(bound.teamName));
      const snapshot = await this.snapshot(bound, context);
      if (snapshot.kind === "no_active_team") return { kind: "unavailable", reason: "no_active_team", message: "No active Team." };
      if (snapshot.kind !== "snapshot") return snapshot;
      if (automatic && !snapshot.tasks.length && !snapshot.workers.length && !baseline?.taskIds.length) return { kind: "quiet" };
      return { ...snapshot, head, epochId: bound.config.epochId };
    }
    const pages = this.pages(bound.teamName, baseline.cursor);
    const tasks = await this.readTaskProjectionOnce(bound.teamName);
    if (tasks.kind !== "tasks") return tasks;
    const revisionChanged = baseline.authorityRevisions.task_projection !== taskProjectionRevision(tasks.tasks, tasks.warnings);
    if (baseline.taskIds.some(id => !tasks.tasks.some(task => task.id === id))) return this.observe(bound, "snapshot", baseline, context, false);
    for (const [index, page] of pages.entries()) {
      const current = new Map(tasks.tasks.map(task => [task.id, task.version]));
      const events = page.events.filter(event => event.type !== "task" || current.get(event.ref.taskId) === event.ref.version);
      const projected = this.projection.projectTaskChanges(events, tasks.tasks);
      if (projected.kind !== "projected") return projected;
      const workerChanges: Extract<CoordinationSyncResult, { kind: "updates" }>["workerChanges"] = page.events.flatMap(event => {
        if (event.type !== "worker") return [];
        const worker = bound.config.logicalWorkers!.find(worker => worker.name === event.worker);
        const c = event.carrier;
        const taskIds = worker ? this.projection.projectNonterminalTaskIds(tasks.tasks, worker.name) : [];
        return worker ? [{ worker: worker.name, scope: worker.scope, kind: event.phase === "prepared" ? "created" : event.phase === "session_bound" ? "connected" : event.phase, text: c
          ? `Worker ${worker.name}: ${c.field} ${c.to}; ${c.cause.source}: ${c.cause.fact}; pane ${c.paneId ?? "unknown"}; suspectedHumanStop=${c.suspectedHumanStop}; nextActionHint=${c.nextActionHint}; nonterminalTaskIds=${taskIds.join(",") || "none"}.`
          : `Worker ${worker.name}: ${event.phase === "failed" ? "startup admission refused" : event.phase.replaceAll("_", " ")}.` }] : [];
      });
      // Eventless authority changes remain visible, including complete removals.
      const changes = projected.changes;
      if (page.events.length === 0 && revisionChanged) {
        if (!tasks.tasks.length) return this.observe(bound, "snapshot", baseline, context, false);
        changes.push(...tasks.tasks.map(task => ({ taskId: task.id, changeKinds: ["progress" as const], journalEntries: [], current: task })));
      }
      if (changes.length || workerChanges.length) {
        selected?.(page, pages.slice(index + 1));
        return { kind: "updates", teamChanges: [], workerChanges, taskChanges: changes, alerts: [], head: Number(page.cursor), epochId: bound.config.epochId, ...(tasks.warnings.length ? { taskProjectionWarnings: tasks.warnings } : {}) };
      }
    }
    if (automatic) return { kind: "quiet" };
    const observations = await this.workerRunObservations(bound);
    const workers = observations.flatMap<Extract<CoordinationSyncResult, { kind: "unsettled" }>["workers"][number]>(item => item.state === "active" ? [{ name: item.worker, reason: "still_active" }] : item.actuationPending ? [{ name: item.worker, reason: "actuation_pending" }] : item.state === "unknown" ? (item.unknownReasons ?? ["run_state_unknown"]).map(reason => ({ name: item.worker, reason })) : []);
    const common = { head: Number(pages.at(-1)!.cursor), epochId: bound.config.epochId };
    return workers.length ? { kind: "unsettled", ...common, workers } : { kind: "caught_up", ...common };
  }
  async peekTeamSync(file: string, view: "snapshot" | "updates", ids: string[]): Promise<CoordinationSyncProbe> {
    if (this.reservations.has(file)) return { kind: "indeterminate", message: "A Team observation is in progress." };
    const bound = await this.boundTeam(file);
    if (!bound) return { kind: "unavailable", reason: "no_active_team", message: "No active Team." };
    const baseline = this.baseline(bound, ids);
    const scopeKey = JSON.stringify([bound.teamName, bound.config.epochId, bound.membershipId, file, baseline, ids.slice(0, (baseline?.lineage.length ?? 0) + 1)]);
    let events: TeamEvent[] = [], laterExternal = false;
    const result = await this.observe(bound, view, baseline, undefined, true, (page, later) => { events = page.events; laterExternal = later.some(page => page.events.some(event => event.type !== "task" || event.actor !== "team-lead")); });
    const latest = await this.boundTeam(file);
    if (!latest || latest.membershipId !== bound.membershipId || latest.config.epochId !== bound.config.epochId || JSON.stringify(this.baseline(latest, ids)) !== JSON.stringify(baseline)) return { kind: "indeterminate", message: "The observation scope changed during the probe." };
    if (result.kind === "snapshot") {
      const removed = baseline?.taskIds.filter(id => !result.tasks.some(task => task.id === id)).length ?? 0;
      return { kind: "prepared", result, updateCount: result.tasks.length + result.workers.length + removed, scopeKey };
    }
    if (result.kind === "updates") {
      const updateCount = result.workerChanges.length + result.taskChanges.filter(change => !events.some(event => event.type === "task" && event.ref.taskId === change.taskId) || events.some(event => event.type === "task" && event.ref.taskId === change.taskId && event.actor !== "team-lead")).length;
      return updateCount || laterExternal ? { kind: "prepared", result, updateCount, scopeKey, ...(laterExternal && !updateCount ? { continuationEligible: true } : {}) } : { kind: "quiet", updateCount: 0, scopeKey };
    }
    if (["quiet", "caught_up", "unsettled"].includes(result.kind)) return { kind: "quiet", updateCount: 0, scopeKey };
    if (result.kind === "cancelled") return { kind: "indeterminate", message: result.message };
    return result as CoordinationSyncProbe;
  }
  async readTaskProjection(team: string): Promise<TaskRead> {
    const pending = this.taskProjectionReads.get(team);
    if (pending) return pending;
    const read = this.readTaskProjectionOnce(team);
    this.taskProjectionReads.set(team, read);
    try { return await read; } finally { if (this.taskProjectionReads.get(team) === read) this.taskProjectionReads.delete(team); }
  }
  private async readTaskProjectionOnce(team: string): Promise<TaskRead> {
    try {
      const ids = await this.coordinationQueries.taskStateDelivery.listTaskIds(team);
      const records = await this.coordinationQueries.taskStateDelivery.readTasks(team, ids);
      if (records.length !== ids.length) throw new Error("Task authority returned an incomplete batch.");
      const tasks: CanonicalTaskCard[] = [];
      for (const [index, record] of records.entries()) {
        if (!record) throw new Error(`Task ${ids[index]} could not be hydrated.`);
        if (record.kind === "contract_gap") return record;
        if (record.task.id !== ids[index]) throw new Error(`Task authority returned the wrong Task for ${ids[index]}.`);
        tasks.push(record.task);
      }
      return { kind: "tasks", tasks, warnings: tasks.flatMap(task => task.projection_warnings ?? []) };
    } catch (error) { return { kind: "unavailable", reason: "task_authority_unavailable", message: error instanceof Error ? error.message : String(error) }; }
  }
  private readWorkers(bound: BoundTeam, tasks: CanonicalTaskCard[]): Array<CoordinationWorkerCurrent & { nonterminalTaskIds: string[] }> {
    return bound.config.logicalWorkers!.map(worker => {
      const member = [...bound.config.members].reverse().find(member => member.name === worker.name && member.isActive !== false);
      return { name: worker.name, scope: worker.scope, carrier: !member ? "absent" as const : member.sessionFile ? "connected" as const : member.pendingLaunchId ? "starting" as const : "absent" as const,
        ...(worker.modelProfile?.alias ? { modelRole: worker.modelProfile.alias } : {}), nonterminalTaskIds: this.projection.projectNonterminalTaskIds(tasks, worker.name) };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  private async workerRunObservations(bound: BoundTeam): Promise<WorkerRunObservation[]> {
    return Promise.all(bound.config.logicalWorkers!.map(async worker => {
      const member = [...bound.config.members].reverse().find(candidate => candidate.name === worker.name && candidate.isActive !== false);
      if (!member) return { worker: worker.name, state: "absent" as const, actuationPending: false };
      const [taskDelivery, alertInbox, runtime] = await Promise.all([this.coordinationQueries.taskStateDelivery.readDeliveryEvidence(bound.teamName, member.name), this.coordinationQueries.alertActuation.readInboxEvidence(bound.teamName, member.name), this.coordinationQueries.teamRuntime.readRuntime(bound.teamName, member).catch(() => null)]);
      return deriveWorkerRunObservation(member, { runtime, taskDelivery, alertInbox });
    }));
  }
}
