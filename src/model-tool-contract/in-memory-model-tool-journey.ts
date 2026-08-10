import { modelToolJourney } from "./model-tool-journey-facade";
import { InMemoryAlertApplicationPort, InMemoryCoordinationApplicationPort, InMemoryTaskApplicationPort, InMemoryTeamApplicationPort } from "./in-memory-authority-ports";
import { inMemoryAlertState, inMemoryCoordinationState, inMemorySupportRevisionClock, inMemoryTaskState, inMemoryTeamState } from "./in-memory-state";

/**
 * Build four isolated fakes with opaque state. Construction uses only lazy
 * narrow query/publication ports; no fake receives a world or sibling fake.
 */
export function createInMemoryModelToolJourney() {
  const teamState = inMemoryTeamState();
  const taskState = inMemoryTaskState();
  const alertState = inMemoryAlertState();
  const coordinationState = inMemoryCoordinationState();
  const supportClock = inMemorySupportRevisionClock();
  const revision = { commit: () => ++supportClock.revision, read: () => supportClock.revision };
  let team: InMemoryTeamApplicationPort;
  let task: InMemoryTaskApplicationPort;
  let coordination: InMemoryCoordinationApplicationPort;
  const teamQuery = { active: (...args: Parameters<InMemoryTeamApplicationPort["active"]>) => team.active(...args), worker: (...args: Parameters<InMemoryTeamApplicationPort["worker"]>) => team.worker(...args), snapshot: (...args: Parameters<InMemoryTeamApplicationPort["snapshot"]>) => team.snapshot(...args) };
  const taskQuery = { record: (...args: Parameters<InMemoryTaskApplicationPort["record"]>) => task.record(...args), tasks: (...args: Parameters<InMemoryTaskApplicationPort["tasks"]>) => task.tasks(...args), nonterminalAssigned: (...args: Parameters<InMemoryTaskApplicationPort["nonterminalAssigned"]>) => task.nonterminalAssigned(...args) };
  const publication = { publish: (...args: Parameters<InMemoryCoordinationApplicationPort["publish"]>) => coordination.publish(...args) };
  coordination = new InMemoryCoordinationApplicationPort(coordinationState, teamQuery, taskQuery, revision);
  team = new InMemoryTeamApplicationPort(teamState, taskQuery, publication, revision);
  task = new InMemoryTaskApplicationPort(taskState, teamQuery, publication, revision);
  const alert = new InMemoryAlertApplicationPort(alertState, teamQuery, publication, revision);
  const ports = { team, task, alert, coordination };
  const journey = modelToolJourney(ports);
  const debug = { readRevision: () => coordination.readDebugRevision(), readState: () => ({ revision: coordination.readDebugRevision(), bindings: [...teamState.bindings].map(([leaderSessionId, teamId]) => ({ leaderSessionId, teamId, teamName: teamState.teams.get(teamId)?.name ?? "" })).sort((a,b) => a.leaderSessionId.localeCompare(b.leaderSessionId)), teams: [...teamState.teams.values()].map(record => ({ id: record.id, name: record.name, purpose: record.purpose, lifecycle: "active" as const, leaderSessionId: record.leaderSessionId, workers: [...record.workers.values()].map(worker => ({ ...worker })).sort((a,b) => a.name.localeCompare(b.name)) })).sort((a,b) => a.name.localeCompare(b.name)) }) };
  // `world` remains a read-only compatibility debug projection, never shared fake state.
  const world = { readDebugRevision: debug.readRevision, readDebugState: debug.readState };
  return { ports, journey, debug, world };
}
