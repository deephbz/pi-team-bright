import { hostEnv } from "../env/host-env";
import { CoordinationObservationService } from "../coordination/observation-service";
import type { BranchEntry } from "../coordination/branch-observation";
import type { TeamEvent } from "../coordination/contracts";
import { projectNonterminalTaskIds, projectTaskChanges } from "./beads-task-adapter";
import type { ExactLeaderSessionId } from "./model-tool-contracts";
import type { InMemoryCoordinationState, InMemoryEvent } from "./in-memory-state";
import type { InMemoryCoordinationPublication, InMemoryPublicationResult, InMemoryTeamQuery, InMemoryTaskQuery, InMemorySupportRevision } from "./in-memory-authority-ports";

/** In-memory authorities and journal primitives feed the production reader. */
export class InMemoryCoordinationApplicationPort implements InMemoryCoordinationPublication {
  readonly observation: CoordinationObservationService;
  private readonly journal = new Map<string, TeamEvent[]>();
  private readonly teamIds = new Map<string, string>();
  constructor(private readonly state: InMemoryCoordinationState, private readonly teams: InMemoryTeamQuery, private readonly tasks: InMemoryTaskQuery, private readonly revision: InMemorySupportRevision) {
    this.observation = new CoordinationObservationService({
      teamRuntime: {
        readLeaderBinding: async file => {
          const team = teams.active(file as ExactLeaderSessionId);
          if (team) this.teamIds.set(team.name, team.id);
          return team && { sessionFile: file, teamName: team.name, purpose: team.purpose, epochId: team.id, logicalWorkers: [...team.workers.values()], syncLiveness: { waitSeconds: 0 }, members: [{ name: "team-lead", agentType: "lead", membershipId: team.id, sessionFile: file, isActive: true }] };
        },
        readRuntime: async () => null,
      },
      taskStateDelivery: {
        listTaskIds: async team => tasks.tasks(this.teamIds.get(team) ?? team).map(task => task.id),
        readTasks: async (team, ids) => ids.map(id => { const task = tasks.tasks(this.teamIds.get(team) ?? team).find(task => task.id === id); return task ? { kind: "found" as const, task } : undefined; }),
        readDeliveryEvidence: async () => ({ known: true, pending: false }),
      },
      alertActuation: { readInboxEvidence: async () => ({ known: true, pending: false }) },
      receivedAlerts: { readRecentReceivedAlerts: async () => ({ alerts: [], omitted: 0 }) },
    }, { projectNonterminalTaskIds, projectTaskChanges }, {
      readEventCursor: team => String(this.journal.get(this.teamIds.get(team) ?? team)?.length ?? 0),
      readEvents: (team, options) => {
        const events = this.journal.get(this.teamIds.get(team) ?? team) ?? [];
        const unseen = events.slice(Number(options?.afterCursor ?? 0));
        const page = unseen.slice(0, options?.limit ?? 50);
        return { events: page, cursor: page.at(-1)?.cursor ?? String(events.length), headCursor: String(events.length), truncated: page.length < unseen.length, remaining: unseen.length - page.length };
      },
    });
  }
  failNextPublication(source: "task" | "alert", count = 1) { this.state.failPublications[source] += count; }
  publish(event: InMemoryEvent, source: "task" | "alert" | "team"): InMemoryPublicationResult {
    if ((source === "task" || source === "alert") && this.state.failPublications[source] > 0) {
      this.state.failPublications[source]--;
      return { kind: "failed", message: `Injected ${source} publication failure.` };
    }
    const events = this.journal.get(event.teamId) ?? [];
    const coordinate = { cursor: String(events.length + 1), at: new Date(hostEnv().clock.now()).toISOString() };
    if (event.taskId) {
      const task = this.tasks.tasks(event.teamId).find(task => task.id === event.taskId)!;
      events.push({ ...coordinate, type: "task", ref: { taskId: task.id, version: task.version as `v_${string}` }, change: event.kind === "task_created" ? "created" : event.statusChanged ? "status" : "note", actor: "team-lead" });
    } else if (event.workerName) {
      events.push({ ...coordinate, type: "worker", worker: event.workerName, membershipId: event.workerName, phase: "prepared" });
    }
    this.journal.set(event.teamId, events);
    return { kind: "published" };
  }
  readSnapshot(session: ExactLeaderSessionId) { return this.observation.readSnapshot(session); }
  readTeamSync(session: ExactLeaderSessionId, view: "snapshot" | "updates", signal: AbortSignal, call: string) { return this.observation.readTeamSync(session, view, signal, call); }
  setPendingObservationResult(session: ExactLeaderSessionId, result: unknown) { this.observation.setPendingResult(session, result); }
  discardPendingObservation(session: ExactLeaderSessionId, call: string) { this.observation.discardPending(session, call); }
  setBranchContext(session: ExactLeaderSessionId, ids: string[]) { this.observation.setBranchContext(session, ids); }
  setBranchEntries(session: ExactLeaderSessionId, entries: BranchEntry[]) { this.observation.setBranchEntries(session, entries); }
  getPendingObservation(session: ExactLeaderSessionId) { return this.observation.pending(session); }
  readSyncNudgeDebt(session: ExactLeaderSessionId, ids: string[]) { return this.observation.readSyncNudgeDebt(session, ids); }
  readDebugRevision() { return this.revision.read(); }
}
