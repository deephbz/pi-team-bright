import { Type, type Static } from "typebox";
/** Durable pane placement policy captured by a Team epoch. */
export declare const TeamPaneLayoutSchema: Type.TObject<{
    leader_share: Type.TNumber;
    worker_tiling: Type.TEnum<["linear", "grid"]>;
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
