export declare const PI_TEAMS_TRACE_JSONL_ENV = "PI_TEAMS_TRACE_JSONL";
export declare function recordBdCall(command: string, durationMs: number, outcome: "ok" | "error"): void;
export declare function recordLockWait(durationMs: number): void;
/** Emit one payload-free canonical JSONL record for a semantic operation. */
export declare function withSemanticTrace<T>(operation: string, identity: {
    teamName?: string;
    taskId?: string;
}, action: () => Promise<T>): Promise<T>;
