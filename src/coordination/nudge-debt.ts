import type { CanonicalTaskCard, TaskCardWarning } from "../task-authority/task-domain";
import type { CoordinationLeaderBindingEvidence } from "./queries";
import { taskProjectionRevision } from "./task-projection-revision";

export type SyncNudgeDebt =
  | { kind: "none" }
  | { kind: "eligible"; debtKey: string; requestedView: "snapshot" | "updates"; teamEpochId: string; leaderSessionId: string; leaderMembershipId: string; branchLineage: string[]; branchId: string; policyVersion: string }
  | { kind: "indeterminate"; message: string }
  | { kind: "unavailable"; message: string };

type BoundNudgeTeam = { teamName: string; sessionFile: string; config: CoordinationLeaderBindingEvidence & { epochId: string; syncLiveness: { nudgeEnabled: boolean; nudgeDelaySeconds: number; policyVersion?: string } } };

/** Narrow Task-projection dependency for nudge debt; it is not an observation service dependency. */
export interface CoordinationNudgeTaskProjectionReader {
  readTaskProjection(teamName: string): Promise<
    | { kind: "tasks"; tasks: CanonicalTaskCard[]; warnings: TaskCardWarning[] }
    | { kind: "contract_gap" | "unavailable"; message: string }
  >;
}

/** Minimal hidden-observation projection needed to derive nudge debt. */
export type CoordinationNudgeHiddenResult =
  | { kind: "found"; projection: { teamEventCursor: string; authorityRevisions: Record<string, string | undefined> } }
  | { kind: "missing" }
  | { kind: "contract_gap"; reason: string };

/** Minimal Team event projection needed to derive nudge debt. */
export interface CoordinationNudgeEvent {
  type: string;
  actor?: string;
}

/** Minimal failed-Task-event hint projection needed to derive nudge debt. */
export interface CoordinationNudgeHint {
  actorKind: "team-lead" | "non-leader/external";
}

/** Derived-record reads used only to calculate nudge debt. */
export interface CoordinationNudgeStore {
  readHidden(teamName: string, input: { teamEpochId: string; exactSessionId: string; branchLineage: string[] }): CoordinationNudgeHiddenResult | Promise<CoordinationNudgeHiddenResult>;
  readEvents(teamName: string, input: { afterCursor?: string }): { events: CoordinationNudgeEvent[]; headCursor: string; cursor: string; truncated: boolean };
  readFailureHints(teamName: string, afterCursor: string, input: { teamEpochId: string; taskReferences: Array<{ taskId: string; taskVersion: CanonicalTaskCard["version"] }> }): { headCursor: string; hints: CoordinationNudgeHint[] };
}

function currentLead(config: CoordinationLeaderBindingEvidence, sessionFile: string) {
  return [...config.members].reverse().find((member) => member.name === "team-lead" && member.agentType === "lead" && member.isActive !== false && member.sessionFile === sessionFile);
}

/** Derives branch-bound nudge debt from Coordination reads. It owns no authority or presentation records. */
export class CoordinationNudgeDebtService {
  constructor(
    private readonly taskProjectionReader: CoordinationNudgeTaskProjectionReader,
    private readonly store: CoordinationNudgeStore,
  ) {}

  async read(bound: BoundNudgeTeam, branchLineage: string[]): Promise<SyncNudgeDebt> {
    const { config } = bound;
    if (!config.syncLiveness.nudgeEnabled) return { kind: "none" };
    const branchId = branchLineage.at(-1);
    if (!branchId || new Set(branchLineage).size !== branchLineage.length) return { kind: "none" };
    const lead = currentLead(config, bound.sessionFile);
    if (!lead?.membershipId) return { kind: "none" };
    const branchKey = JSON.stringify(branchLineage);
    const hidden = await this.store.readHidden(bound.teamName, { teamEpochId: config.epochId, exactSessionId: bound.sessionFile, branchLineage });
    if (hidden.kind === "contract_gap") return { kind: "unavailable", message: `Model-tool ${hidden.reason.replaceAll("_", " ")} is unavailable.` };
    const tasksResult = await this.taskProjectionReader.readTaskProjection(bound.teamName);
    if (tasksResult.kind !== "tasks") return { kind: "unavailable", message: tasksResult.message };
    const events = this.readAllEvents(bound.teamName, hidden.kind === "found" ? hidden.projection.teamEventCursor : undefined);
    const currentRevision = taskProjectionRevision(tasksResult.tasks, tasksResult.warnings);
    const currentCursor = events.headCursor;
    // Historical Team records can omit this optional provenance field. Keep
    // JavaScript interpolation and returned legacy shape unchanged.
    const policyVersion = config.syncLiveness.policyVersion as string;
    if (hidden.kind !== "found") {
      const debtKey = `${config.epochId}|${bound.sessionFile}|${lead.membershipId}|${branchKey}|snapshot|${currentCursor}|${currentRevision}|${policyVersion}`;
      return { kind: "eligible", debtKey, requestedView: "snapshot", teamEpochId: config.epochId, leaderSessionId: bound.sessionFile, leaderMembershipId: lead.membershipId, branchLineage: [...branchLineage], branchId, policyVersion };
    }
    const acknowledgedRevision = hidden.projection.authorityRevisions.task_projection;
    const acknowledgedHintCursor = hidden.projection.authorityRevisions.task_event_failure_hints ?? "0";
    let hintBatch: { headCursor: string; hints: CoordinationNudgeHint[] };
    try {
      hintBatch = this.store.readFailureHints(bound.teamName, acknowledgedHintCursor, { teamEpochId: config.epochId, taskReferences: tasksResult.tasks.map((task) => ({ taskId: task.id, taskVersion: task.version })) });
    } catch (error) {
      return { kind: "indeterminate", message: `Failed-event hint evidence is unavailable; automatic sync nudge is suppressed. ${error instanceof Error ? error.message : String(error)}` };
    }
    const hintCursorChanged = hintBatch.headCursor !== acknowledgedHintCursor;
    const externalHint = hintBatch.hints.some((match) => match.actorKind === "non-leader/external");
    const leaderHint = hintBatch.hints.some((match) => match.actorKind === "team-lead");
    const taskEvents = events.events.filter((event) => event.type === "task");
    const nonLeaderTaskChange = taskEvents.some((event) => event.actor !== "team-lead");
    const leaderTaskChange = taskEvents.some((event) => event.actor === "team-lead");
    const pairChanged = hidden.projection.teamEventCursor !== currentCursor || acknowledgedRevision !== currentRevision || hintCursorChanged;
    if (!pairChanged || (acknowledgedRevision === currentRevision && !hintCursorChanged && !nonLeaderTaskChange && !leaderTaskChange)) return { kind: "none" };
    if (nonLeaderTaskChange || externalHint) {
      const debtKey = `${config.epochId}|${bound.sessionFile}|${lead.membershipId}|${branchKey}|updates|${hidden.projection.teamEventCursor}:${acknowledgedRevision}:${acknowledgedHintCursor}->${currentCursor}:${currentRevision}:${hintBatch.headCursor}|${policyVersion}`;
      return { kind: "eligible", debtKey, requestedView: "updates", teamEpochId: config.epochId, leaderSessionId: bound.sessionFile, leaderMembershipId: lead.membershipId, branchLineage: [...branchLineage], branchId, policyVersion };
    }
    if (leaderTaskChange || leaderHint) return { kind: "none" };
    return { kind: "indeterminate", message: "Task or failed-event evidence changed without actor evidence; automatic sync nudge is suppressed." };
  }

  private readAllEvents(teamName: string, afterCursor?: string): { events: CoordinationNudgeEvent[]; headCursor: string } {
    const events: CoordinationNudgeEvent[] = [];
    let cursor = afterCursor;
    do {
      const page = this.store.readEvents(teamName, { ...(cursor === undefined ? {} : { afterCursor: cursor }) });
      events.push(...page.events);
      if (!page.truncated) return { events, headCursor: page.headCursor };
      if (page.cursor === cursor) throw new Error("Team nudge event pagination did not advance.");
      cursor = page.cursor;
    } while (true);
  }
}
