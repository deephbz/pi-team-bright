/** Coordination-owned policy persisted on the Team record for one epoch. */
export interface TeamConfigSyncLiveness {
    /** Resolved Team-sync liveness policy for this epoch. */
    syncLiveness?: {
        waitSeconds: number;
        nudgeEnabled: boolean;
        nudgeDelaySeconds?: number;
        policyVersion: string;
        diagnostics?: string[];
    };
}
