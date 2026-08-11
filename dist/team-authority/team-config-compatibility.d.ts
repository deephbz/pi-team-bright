import type { TeamConfigSyncLiveness } from "../coordination/team-config-sync-liveness";
import type { TeamConfigTaskAuthority } from "../task-authority/team-config-task-authority";
import type { TeamPaneLayout } from "../utils/team-pane-layout";
import type { LogicalWorker, Member } from "./contracts";
/**
 * Persisted Team record compatibility seam.
 *
 * Team epoch fields remain Team-owned. Coordination and Task append their
 * consumer-owned persisted fields here so historical config.json records keep
 * one unchanged shape without making either authority own the other fields.
 */
export interface TeamConfig extends TeamConfigSyncLiveness, TeamConfigTaskAuthority {
    name: string;
    description: string;
    createdAt: number;
    leadAgentId: string;
    leadSessionId: string;
    /** Opaque identity for this stopped/restarted Team epoch. Absent on legacy records. */
    epochId?: string;
    /** Historical package-build provenance. It is not a storage compatibility coordinate. */
    implementationVersion?: string;
    /** Stable logical Workers. Absent on legacy records; Memberships remain carriers. */
    logicalWorkers?: LogicalWorker[];
    members: Member[];
    defaultModel?: string;
    separateWindows?: boolean;
    /** Resolved once at Team creation; live epochs do not follow later settings changes. */
    paneLayout?: TeamPaneLayout;
    /** One terminal backend owns every current Member target in this Team epoch. */
    terminalBackend?: string;
}
