import type { TeamEvent } from "./contracts";
import { projectTaskEventEvidence, type TaskEventEvidenceKind } from "./event-journal";
import type { ModelToolTaskJournalEntry } from "../task-authority/contracts";
import { isTaskTerminal, type CanonicalTaskCard } from "../task-authority/task-domain";

const JOURNAL_KINDS = new Set<TaskEventEvidenceKind>(["progress", "decision", "blocker", "result", "note"]);

export interface TaskChangeProjection {
  taskId: string;
  changeKinds: Array<"created" | "goal" | "assignment" | "progress" | "status" | "relation">;
  journalEntries: ModelToolTaskJournalEntry[];
  current: CanonicalTaskCard;
}

export type TaskChangesOutcome =
  | { kind: "projected"; changes: TaskChangeProjection[] }
  | {
    kind: "contract_gap";
    reason: "structured_task_event_evidence_absent";
    taskId: string;
    eventId: string;
    message: string;
  };

/** Derive Worker work from authoritative assignment and status; store no index. */
export function projectNonterminalTaskIds(tasks: readonly CanonicalTaskCard[], workerName: string): string[] {
  return tasks.filter(task => task.assignee === workerName && !isTaskTerminal(task)).map(task => task.id).sort();
}

export function projectTaskJournalEntry(event: TeamEvent): ModelToolTaskJournalEntry | undefined {
  const evidence = projectTaskEventEvidence(event);
  if (!evidence || !JOURNAL_KINDS.has(evidence.kind)) return undefined;
  return {
    id: evidence.id,
    at: evidence.at,
    actor: evidence.actor,
    kind: evidence.kind as ModelToolTaskJournalEntry["kind"],
    text: evidence.text,
  };
}

function changeKind(event: TeamEvent): TaskChangeProjection["changeKinds"][number] | undefined {
  if (event.type !== "task") return undefined;
  const evidence = projectTaskEventEvidence(event);
  if (evidence) {
    if (JOURNAL_KINDS.has(evidence.kind)) return "progress";
    if (["created", "goal", "assignment", "status", "relation"].includes(evidence.kind)) {
      return evidence.kind as TaskChangeProjection["changeKinds"][number];
    }
  }
  if (event.change === "created") return "created";
  if (event.change === "assigned") return "assignment";
  if (event.change === "status") return "status";
  if (event.change === "relation") return "relation";
  return undefined;
}

/** Group committed Task evidence and attach one latest canonical current state. */
export function projectTaskChanges(events: readonly TeamEvent[], currentTasks: readonly CanonicalTaskCard[]): TaskChangesOutcome {
  const currentById = new Map(currentTasks.map(task => [task.id, task]));
  const grouped = new Map<string, Omit<TaskChangeProjection, "current">>();
  for (const event of events) {
    if (event.type !== "task") continue;
    const task = currentById.get(event.ref.taskId);
    if (!task) continue;
    // Structural Task events remain useful without narrative evidence. Only
    // evidence-backed entries contribute journal content below.
    if (!projectTaskEventEvidence(event)) {
      if (event.change === "note") {
        return {
          kind: "contract_gap",
          reason: "structured_task_event_evidence_absent",
          taskId: task.id,
          eventId: `task-event-${event.cursor}`,
          message: `Task event ${event.cursor} has no structured actor/kind/text evidence; Task updates cannot reconstruct it safely.`,
        };
      }
      if (!changeKind(event)) continue;
    }
    const group = grouped.get(task.id) ?? { taskId: task.id, changeKinds: [], journalEntries: [] };
    const kind = changeKind(event);
    if (kind && !group.changeKinds.includes(kind)) group.changeKinds.push(kind);
    const journalEntry = projectTaskJournalEntry(event);
    if (journalEntry) group.journalEntries.push(journalEntry);
    grouped.set(task.id, group);
  }
  return {
    kind: "projected",
    changes: [...grouped.values()].flatMap(group => {
      const task = currentById.get(group.taskId);
      if (!task || group.changeKinds.length === 0) return [];
      return [{ ...group, current: task }];
    }),
  };
}
