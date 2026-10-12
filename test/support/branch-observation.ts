import { TEAM_UPDATE_TYPE, type BranchEntry } from "../../src/coordination/branch-observation";
import type { CoordinationObservationService } from "../../src/coordination/observation-service";
import type { CanonicalTaskCard } from "../../src/task-authority/task-domain";

export function snapshotEntry(id: string, team: string, epoch: string, binding: string, tasks: CanonicalTaskCard[] = [], through = 0): BranchEntry {
  return { id, type: "custom_message", customType: TEAM_UPDATE_TYPE, details: { team, epoch, binding, from: 0, through }, content: JSON.stringify({ kind: "snapshot", tasks }) };
}
export function persistPortObservation(port: { getPendingObservation(session: any): any; setBranchEntries(session: any, entries: BranchEntry[]): void }, session: string, id = "native", branch: BranchEntry[] = []): BranchEntry[] {
  const pending = port.getPendingObservation(session);
  if (!pending?.observation) throw new Error("No reserved observation.");
  const result = pending.result;
  const content = result.kind === "updates" ? { ...result, task_changes: result.taskChanges.map((change: any) => ({ current: change.current })) } : result;
  const entries = [...branch, { id, type: "custom_message", customType: TEAM_UPDATE_TYPE, details: pending.observation, content: JSON.stringify(content) }];
  port.setBranchEntries(session, entries);
  return entries;
}
export function persistObservation(service: CoordinationObservationService, session: string, entry: string, branch: BranchEntry[]): BranchEntry[] {
  const pending = service.pending(session);
  if (!pending?.observation) throw new Error("No observation was reserved.");
  const result = pending.result;
  const content = result.kind === "updates" ? { ...result, task_changes: result.taskChanges.map(change => ({ current: change.current })) } : result;
  const next = [...branch, { id: entry, type: "custom_message", customType: TEAM_UPDATE_TYPE, details: pending.observation, content: JSON.stringify(content) }];
  service.setBranchEntries(session, next);
  return next;
}
