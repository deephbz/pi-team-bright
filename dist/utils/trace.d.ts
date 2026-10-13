export declare const PI_TEAMS_TRACE_JSONL_ENV = "PI_TEAMS_TRACE_JSONL";
/** Payload-free stages from parent launch through child Session admission. */
export type WorkerLaunchStage = "ensure_started" | "carrier_reused" | "membership_prepared" | "carrier_start_accepted" | "carrier_label_applied" | "carrier_label_not_applied" | "carrier_target_persisted" | "session_bound_observed" | "session_bound_not_observed" | "compensation_started" | "carrier_stop_confirmed" | "recovery_authority_won" | "session_binding_won" | "membership_deactivated" | "compensation_unconfirmed" | "worker_session_started" | "membership_validated" | "runtime_admission_refused" | "runtime_generation_claimed" | "session_bound_persisted" | "session_bound_published";
interface BdRunnerLifecycleTrace {
    event: "start" | "deadline" | "termination_cleanup" | "settled";
    durationMs: number;
    timedOut: boolean;
}
export declare function recordBdCall(command: string, durationMs: number, outcome: "ok" | "error"): void;
/** Record payload-free owned-process lifecycle evidence in a semantic trace. */
export declare function recordBdRunnerLifecycle(event: BdRunnerLifecycleTrace["event"], durationMs: number, timedOut: boolean): void;
export declare function recordLockWait(durationMs: number): void;
/** Record one monotonic, payload-free Worker launch stage in the active trace. */
export declare function recordWorkerLaunchStage(stage: WorkerLaunchStage, details?: {
    membershipId?: string;
}): void;
/** Emit one payload-free canonical JSONL record for a semantic operation. */
export declare function withSemanticTrace<T>(operation: string, identity: {
    teamName?: string;
    taskId?: string;
    workerName?: string;
}, action: () => Promise<T>): Promise<T>;
export {};
