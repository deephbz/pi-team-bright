export declare const TASK_OBSERVATION_SCHEMA: "pi-team-tasks/1";
export type TaskObservation = {
    id: string;
    title: string;
    status: string;
    owner?: string;
    deps: string[];
    ready: boolean;
};
export type TaskObservationSnapshot = {
    schema: typeof TASK_OBSERVATION_SCHEMA;
    teamName: string;
    generatedAt: string;
    availability: "available" | "unavailable";
    tasks: TaskObservation[];
    issues: string[];
};
export interface ReadTaskOptions {
    teamName: string;
    teamsRoot?: string;
    deadlineMs?: number;
    signal?: AbortSignal;
}
/** Read-only atomic-snapshot projection. A missing/corrupt authority is never an empty graph.
 * Warm reads stat only. No leases, directory creation, runtime probes, or delivery effects.
 */
export declare function readTaskSnapshot(options: ReadTaskOptions): Promise<TaskObservationSnapshot>;
