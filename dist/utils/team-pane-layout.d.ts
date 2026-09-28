import { Type, type Static } from "typebox";
/** Durable pane placement policy captured by a Team epoch. */
export declare const DEFAULT_COLUMNS_PER_ROW = 2;
export declare const MIN_WORKER_PANE_WIDTH = 20;
export declare const MIN_WORKER_PANE_HEIGHT = 5;
export declare const TeamPaneLayoutSchema: Type.TObject<{
    leader_share: Type.TNumber;
    /** `grid` is retained as a read-compatible alias for adaptive placement. */
    worker_tiling: Type.TEnum<["linear", "adaptive", "grid"]>;
    columns_per_row: Type.TOptional<Type.TInteger>;
    /** Optional cap on registered Workers. Omitted preserves the historical unlimited behavior. */
    worker_limit: Type.TOptional<Type.TInteger>;
}>;
export type TeamPaneLayout = Static<typeof TeamPaneLayoutSchema>;
export declare const DEFAULT_TEAM_PANE_LAYOUT: TeamPaneLayout;
export type TeamPaneLayoutSource = "team_create" | "trusted project Pi settings" | "global Pi settings";
/** Read only the global policy and, when trusted, the nearest project policy. */
export declare function loadTeamPaneLayoutSettings(input: {
    cwd: string;
    projectTrusted: boolean;
    agentDir?: string;
}): {
    project?: unknown;
    global?: unknown;
};
/** Refuse policies that the selected terminal adapter cannot implement. */
export declare function assertTeamPaneLayoutSupported(policy: TeamPaneLayout, backend: string): void;
/** Resolve explicit input, trusted project settings, global settings, then defaults. */
export declare function resolveTeamPaneLayout(input: {
    explicit?: unknown;
    project?: unknown;
    global?: unknown;
    backend: string;
}): TeamPaneLayout;
/** Validate a policy already loaded from a TeamConfig or a direct adapter caller. */
export declare function normalizeTeamPaneLayout(value: unknown, backend?: string): TeamPaneLayout;
