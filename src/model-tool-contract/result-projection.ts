import type { Static } from "typebox";
import { Check } from "typebox/value";
import {
  CandidateEnsureWorkerResultSchema,
  CandidateTaskCreateResultSchema,
  CandidateTaskReadResultSchema,
  CandidateTaskUpdateResultSchema,
  CandidateTeamCreateResultSchema,
  CandidateTeamSyncResultSchema,
  CandidateWorkerStopResultSchema,
  CandidateTeamShutdownResultSchema,
  CandidateTaskLinkResultSchema,
  CandidateAlertSendResultSchema,
} from "./catalog";

export type CandidateProjectedTool = "team_create" | "team_sync" | "ensure_worker" | "task_create" | "task_read" | "task_update" | "worker_stop" | "team_shutdown" | "task_link" | "alert_send";

export type CandidateToolSemanticResult<TTool extends CandidateProjectedTool> =
  TTool extends "team_create" ? Static<typeof CandidateTeamCreateResultSchema>
    : TTool extends "team_sync" ? Static<typeof CandidateTeamSyncResultSchema>
      : TTool extends "ensure_worker" ? Static<typeof CandidateEnsureWorkerResultSchema>
        : TTool extends "task_create" ? Static<typeof CandidateTaskCreateResultSchema>
          : TTool extends "task_read" ? Static<typeof CandidateTaskReadResultSchema>
            : TTool extends "task_update" ? Static<typeof CandidateTaskUpdateResultSchema>
              : TTool extends "worker_stop" ? Static<typeof CandidateWorkerStopResultSchema>
                : TTool extends "team_shutdown" ? Static<typeof CandidateTeamShutdownResultSchema>
                  : TTool extends "task_link" ? Static<typeof CandidateTaskLinkResultSchema>
                    : Static<typeof CandidateAlertSendResultSchema>;

export interface CandidateToolResultAssembly<TDetails> {
  content: [{ type: "text"; text: string }];
  details: TDetails;
}

function isValidCandidateToolResult(tool: CandidateProjectedTool, result: unknown): boolean {
  if (tool === "team_create") return Check(CandidateTeamCreateResultSchema, result);
  if (tool === "team_sync") return Check(CandidateTeamSyncResultSchema, result);
  if (tool === "ensure_worker") return Check(CandidateEnsureWorkerResultSchema, result);
  if (tool === "task_create") return Check(CandidateTaskCreateResultSchema, result);
  if (tool === "task_read") return Check(CandidateTaskReadResultSchema, result);
  if (tool === "task_update") return Check(CandidateTaskUpdateResultSchema, result);
  if (tool === "worker_stop") return Check(CandidateWorkerStopResultSchema, result);
  if (tool === "team_shutdown") return Check(CandidateTeamShutdownResultSchema, result);
  if (tool === "task_link") return Check(CandidateTaskLinkResultSchema, result);
  return Check(CandidateAlertSendResultSchema, result);
}

/**
 * Internal model-result projection seam for the initial end-to-end delivery.
 *
 * This function intentionally returns the validated semantic result unchanged.
 * Named JSON is the model-facing default, so the model does not need a separate
 * positional-field protocol. Projection design is deferred experimentation. It
 * must not change tool semantics, extension features, or domain behavior.
 */
export function projectCandidateToolResult<TTool extends CandidateProjectedTool>(
  tool: TTool,
  result: CandidateToolSemanticResult<TTool>,
): CandidateToolSemanticResult<TTool>;
export function projectCandidateToolResult(tool: CandidateProjectedTool, result: unknown): unknown;
export function projectCandidateToolResult(tool: CandidateProjectedTool, result: unknown): unknown {
  if (!isValidCandidateToolResult(tool, result)) {
    throw new Error(`Invalid candidate ${tool} result.`);
  }
  return result;
}

/** Serialize the unchanged named result for Pi tool-result text content. */
export function serializeCandidateToolResult(tool: CandidateProjectedTool, result: unknown): string {
  return JSON.stringify(projectCandidateToolResult(tool, result));
}

/** Assemble Pi content and details from one validated canonical semantic result. */
export function assembleCandidateToolResult<TTool extends CandidateProjectedTool>(
  tool: TTool,
  result: CandidateToolSemanticResult<TTool>,
): CandidateToolResultAssembly<CandidateToolSemanticResult<TTool>> {
  const details = projectCandidateToolResult(tool, result);
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

/** Parse and validate named model content for contract and trace tests. */
export function parseCandidateToolResult(tool: CandidateProjectedTool, content: string): unknown {
  const result: unknown = JSON.parse(content);
  if (!isValidCandidateToolResult(tool, result)) {
    throw new Error(`Model content did not decode to a valid ${tool} result.`);
  }
  return result;
}
