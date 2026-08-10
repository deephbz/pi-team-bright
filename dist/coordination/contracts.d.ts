/**
 * Coordination persists event references only. These structural types avoid an
 * import from a Task, Alert, Team, or Trio implementation.
 */
type TaskVersionRef = `v_${string}`;
type AlertKind = "clarification" | "attention" | "announcement";
export type TeamEventType = "task" | "worker" | "alert";
export type TaskEventChange = "created" | "assigned" | "goal" | "note" | "status" | "relation";
export interface TaskTeamEvent {
    type: "task";
    cursor: string;
    ref: {
        taskId: string;
        version: TaskVersionRef;
    };
    change: TaskEventChange;
    actor: string;
    at: string;
}
export type WorkerEventPhase = "prepared" | "session_bound" | "stopped" | "failed";
export interface WorkerRuntimeGenerationEvidence {
    membershipId: string;
    pid: number;
    startedAt: number;
}
export interface WorkerTeamEvent {
    type: "worker";
    cursor: string;
    worker: string;
    membershipId: string;
    phase: WorkerEventPhase;
    /** Absent on legacy journal records; required for new session_bound evidence. */
    generation?: WorkerRuntimeGenerationEvidence;
    at: string;
}
export interface AlertTeamEvent {
    type: "alert";
    cursor: string;
    alertId: string;
    from: string;
    to: string | "*";
    taskRef?: {
        taskId: string;
        version?: TaskVersionRef;
    };
    kind: AlertKind;
    text: string;
    at: string;
}
/** Ordered observation of committed state; it is not a second Task or Worker authority. */
export type TeamEvent = TaskTeamEvent | WorkerTeamEvent | AlertTeamEvent;
export type TeamEventInput = Omit<TaskTeamEvent, "cursor" | "at"> | Omit<WorkerTeamEvent, "cursor" | "at"> | Omit<AlertTeamEvent, "cursor" | "at">;
export {};
