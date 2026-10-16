import { parseObservationContent } from "./observation-content";
import { taskProjectionRevision } from "./task-projection-revision";
import type { CanonicalTaskCard } from "../task-authority/task-domain";

export const TEAM_UPDATE_TYPE = "ptb.team-update";
export interface ObservationStamp {
  team: string;
  epoch: string;
  binding: string;
  from: number;
  through: number;
}
export interface BranchEntry {
  id: string;
  type: string;
  customType?: string;
  details?: unknown;
  content?: unknown;
  message?: { role: string; toolName?: string; details?: unknown; content?: unknown; isError?: boolean };
}
export interface BranchObservation {
  entryId: string;
  lineage: string[];
  cursor: string;
  authorityRevisions: Record<string, string>;
  taskIds: string[];
}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
export function observationStamp(value: unknown): ObservationStamp | undefined {
  if (!object(value) || !["team", "epoch", "binding"].every(key => typeof value[key] === "string" && value[key])
    || !Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.through) || value.from < 0 || value.through < value.from) return undefined;
  return value as ObservationStamp;
}
function contentResult(content: unknown): any {
  try {
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.find(part => part.type === "text")?.text : undefined;
    return text ? parseObservationContent(text) : undefined;
  } catch { return undefined; }
}
/** Only the authorized reader supplies scope. Copied entries cannot bind a fork. */
export function readBranchObservation(branch: readonly BranchEntry[], scope: Pick<ObservationStamp, "team" | "epoch" | "binding">): BranchObservation | undefined {
  // The last stamped entry wins. Build its lineage and revision once, after the scan.
  let last: { index: number; cursor: number } | undefined;
  const tasks = new Map<string, CanonicalTaskCard>();
  let complete = false;
  for (const [index, entry] of branch.entries()) {
    const custom = entry.type === "custom_message" && entry.customType === TEAM_UPDATE_TYPE;
    const tool = entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "team_sync" && !entry.message.isError;
    if (!custom && !tool) continue;
    const details = custom ? entry.details : entry.message?.details;
    const stamp = observationStamp(custom ? details : object(details) ? details.observation : undefined);
    if (!stamp || stamp.team !== scope.team || stamp.epoch !== scope.epoch || stamp.binding !== scope.binding) continue;
    if (last && stamp.through < last.cursor) continue;
    const result = custom ? contentResult(entry.content) : details;
    if (result?.kind === "snapshot" && Array.isArray(result.tasks)) {
      tasks.clear();
      for (const task of result.tasks) tasks.set(task.id, task);
      complete = true;
    } else if (result?.kind === "updates" && Array.isArray(result.task_changes)) {
      for (const change of result.task_changes) if (change.current) tasks.set(change.current.id, change.current);
    }
    last = { index, cursor: stamp.through };
  }
  if (!last) return undefined;
  return {
    entryId: branch[last.index]!.id,
    lineage: branch.slice(0, last.index + 1).map(item => item.id),
    cursor: String(last.cursor),
    authorityRevisions: complete ? { task_projection: taskProjectionRevision([...tasks.values()], [...tasks.values()].flatMap(task => task.projection_warnings ?? [])) } : {},
    taskIds: [...tasks.keys()],
  };
}
