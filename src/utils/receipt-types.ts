/** Internal legacy-shell receipt helpers. Public model results use the catalog projection boundary. */
export type ToolResultOutcome = "accepted" | "partial" | "refused";

export interface ToolResultResource {
  kind: "team" | "worker" | "task" | "alert";
  id: string;
  teamName?: string;
}

export interface ToolResultWarning {
  code: string;
  message: string;
  resourceId?: string;
}

export interface ToolResultNextAction {
  tool: string;
  reason: string;
  args?: Record<string, unknown>;
}

export type WorkerLaunchObservationState =
  | { carrier: "session_bound"; runtime: "observed" }
  | { carrier: "prepared" | "session_bound"; runtime: "not_observed" };

export type WorkerEnsurePostState = Record<string, unknown> & {
  name: string;
  action: "created" | "reused" | "recovered";
};

export interface PiTeamsToolResultDetails<TPostState = unknown, TEvidence = unknown, TDiagnostics = unknown> {
  outcome: ToolResultOutcome;
  operation: string;
  resource?: ToolResultResource;
  postState?: TPostState;
  warnings: ToolResultWarning[];
  nextActions: ToolResultNextAction[];
  evidence?: TEvidence;
  diagnostics?: TDiagnostics;
}

export function toolResultDetails<TPostState = unknown, TEvidence = unknown, TDiagnostics = unknown>(input: {
  outcome?: ToolResultOutcome;
  operation: string;
  resource?: ToolResultResource;
  postState?: TPostState;
  warnings?: ToolResultWarning[];
  nextActions?: ToolResultNextAction[];
  evidence?: TEvidence;
  diagnostics?: TDiagnostics;
}): PiTeamsToolResultDetails<TPostState, TEvidence, TDiagnostics> {
  return {
    outcome: input.outcome ?? "accepted",
    operation: input.operation,
    ...(input.resource ? { resource: input.resource } : {}),
    ...(input.postState !== undefined ? { postState: input.postState } : {}),
    warnings: input.warnings ?? [],
    nextActions: input.nextActions ?? [],
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    ...(input.diagnostics !== undefined ? { diagnostics: input.diagnostics } : {}),
  };
}

export function warning(code: string, message: string, resourceId?: string): ToolResultWarning {
  return { code, message, ...(resourceId ? { resourceId } : {}) };
}
