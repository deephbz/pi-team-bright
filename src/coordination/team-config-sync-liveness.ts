/** Coordination-owned policy persisted on the Team record for one epoch. */
export interface TeamConfigSyncLiveness {
  /** Resolved Team-sync liveness policy for this epoch. */
  syncLiveness?: {
    waitSeconds: number;
    autoSyncEnabled?: boolean;
    autoSyncDelaySeconds?: number;
    autoSyncUpdateThreshold?: number;
    /** Historical Team settings remain readable as provenance. */
    nudgeEnabled?: boolean;
    nudgeDelaySeconds?: number;
    policyVersion: string;
    diagnostics?: string[];
  };
}
