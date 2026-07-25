export const PI_TEAMS_TOOL_RESULT_SCHEMA = "pi-teams-tool-result/1" as const;

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

/** Public machine post-state for successful `worker_ensure` outcomes. */
export type WorkerEnsurePostState =
  | {
    name: string;
    action: "created";
    membership: "current";
    carrier: "prepared";
    terminalLaunched: true;
    runtime: "not_observed";
    assignedTasks: [];
  }
  | {
    name: string;
    action: "reused";
    membership: "current";
    carrier: "prepared" | "session_bound";
    taskStateChanged: false;
  }
  | {
    name: string;
    action: "recovered";
    recoveryMode: "first_binding_retry" | "exact_session_resume";
    membership: "current";
    carrier: "prepared" | "session_bound";
    terminalLaunched: true;
    runtime: "not_observed";
    taskStateChanged: false;
  };

export type WorkerEnsureAction = WorkerEnsurePostState["action"];
export type WorkerEnsureRecoveryMode = Extract<WorkerEnsurePostState, { action: "recovered" }>["recoveryMode"];

/**
 * The Session/machine record for every public PiTeams tool.
 *
 * Agent-facing content and human-facing rendering are deliberately separate
 * projections. This envelope retains typed post-state and evidence without
 * forcing either audience to parse backend records or transport identifiers.
 *
 * Design context: docs/current/README.md and
 * docs/journal/2026-07-17-task-first-agent-coordination-design.md
 */
export interface PiTeamsToolResultDetails<TPostState = unknown, TEvidence = unknown, TDiagnostics = unknown> {
  schema: typeof PI_TEAMS_TOOL_RESULT_SCHEMA;
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
    schema: PI_TEAMS_TOOL_RESULT_SCHEMA,
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
