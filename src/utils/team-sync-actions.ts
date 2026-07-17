import type { TeamCurrentProjection } from "./team-events";
import type { ToolResultNextAction } from "./tool-results";

type SyncCompletion = "snapshot" | "events" | "timeout";

interface HydratedTaskState {
  id: string;
  status: "open" | "in_progress" | "blocked" | "closed";
  assignee?: string;
  version: string;
  notes?: string | null;
  relations?: readonly { relation: string; targetId: string }[];
}

export interface TeamSyncActionInput {
  teamName: string;
  cursor: string;
  completion: SyncCompletion;
  projection: TeamCurrentProjection;
  hydratedTasks: readonly HydratedTaskState[];
}

function explicitNextAction(notes: string | null | undefined): string | undefined {
  if (!notes) return undefined;
  const matches = [...notes.matchAll(/\bnext action\s*:\s*([^\n]+)/gi)];
  const latest = matches.at(-1)?.[1]?.trim().replace(/[.!?]+$/, "");
  if (!latest) return undefined;
  return latest.replace(/\s+(?:and|then)\s+reassigns?\b.*$/i, "").trim();
}

function isLeadOwned(action: string | undefined): boolean {
  return action !== undefined && /\b(?:team[- ]?lead|coordinator|lead)\b/i.test(action);
}

export function summarizeTeamSyncNextActions(actions: readonly ToolResultNextAction[]): string | undefined {
  if (actions.length === 0) return undefined;
  const visible = actions.slice(0, 3).map(action => action.reason);
  const remainder = actions.length - visible.length;
  return `Next: ${visible.join(" ")}${remainder > 0 ? ` ${remainder} more lifecycle action${remainder === 1 ? "" : "s"} available.` : ""}`;
}

/**
 * Select lifecycle recommendations from the authoritative sync projection.
 * Existing idle Workers take precedence over stopping or creating Workers
 * whenever executable unassigned work already exists.
 */
export function selectTeamSyncNextActions(input: TeamSyncActionInput): ToolResultNextAction[] {
  const blockedUnassigned = input.hydratedTasks.filter(
    task => task.status === "blocked" && !task.assignee,
  );
  const idleWorkers = input.projection.workers.filter(
    worker => worker.carrier !== "absent" && worker.nonterminalTasks.length === 0,
  );
  const executableUnassigned = input.projection.tasks.filter(
    task => task.status === "open" && !task.assignee,
  );

  const leadOwnedBlockerTaskIds = new Set(
    blockedUnassigned.flatMap((task) => {
      const action = explicitNextAction(task.notes);
      if (!isLeadOwned(action)) return [];
      return (task.relations ?? [])
        .filter(relation => relation.relation === "blocked_by")
        .map(relation => relation.targetId);
    }),
  );
  const workerExecutableUnassigned = executableUnassigned.filter(
    task => !leadOwnedBlockerTaskIds.has(task.id),
  );

  const unblockActions = blockedUnassigned.map((task): ToolResultNextAction => ({
    tool: "task_update",
    reason: explicitNextAction(task.notes)
      ? `Before reassigning Task ${task.id}, ${explicitNextAction(task.notes)}.`
      : `Before reassigning Task ${task.id}, resolve its recorded blocker.`,
    args: { team_name: input.teamName, task_id: task.id, expected_version: task.version },
  }));
  const assignmentActions = workerExecutableUnassigned
    .slice(0, idleWorkers.length)
    .map((task, index): ToolResultNextAction => {
      const worker = idleWorkers[index];
      return {
        tool: "task_update",
        reason: `Reuse existing idle Worker ${worker.name} by assigning open Task ${task.id} before creating or stopping a Worker.`,
        args: {
          team_name: input.teamName,
          task_id: task.id,
          assignee: worker.name,
          ...(task.version ? { expected_version: task.version } : {}),
        },
      };
    });
  const stopActions = workerExecutableUnassigned.length === 0
    ? idleWorkers.map((worker): ToolResultNextAction => ({
        tool: "worker_stop",
        reason: leadOwnedBlockerTaskIds.size > 0
          ? `Worker ${worker.name} is idle and can stop while the explicit lead-owned blocker decision remains.`
          : `Worker ${worker.name} has no nonterminal assigned Tasks and is a shutdown candidate because no open unassigned Task is available.`,
        args: { team_name: input.teamName, worker: worker.name },
      }))
    : [];
  const actionable = unblockActions.length + assignmentActions.length + stopActions.length;
  const waitActions = input.completion === "timeout" || (input.completion === "events" && actionable === 0)
    ? [{
        tool: "team_sync",
        reason: "Wait from this cursor only when another Team or Task change is needed.",
        args: { team_name: input.teamName, cursor: input.cursor },
      }]
    : [];

  return [...unblockActions, ...assignmentActions, ...stopActions, ...waitActions];
}
