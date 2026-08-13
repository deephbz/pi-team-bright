import type { CanonicalTaskCard, TaskCardWarning } from "../task-authority/task-domain";
import type { ModelToolTaskJournalEntry } from "../task-authority/contracts";

export interface CoordinationTeamCurrent {
  name: string;
  purpose: string;
  lifecycle: "active";
}

export interface CoordinationWorkerCurrent {
  name: string;
  scope: string;
  carrier: "starting" | "connected" | "absent";
}

export type CoordinationSnapshotResult =
  | { kind: "snapshot"; team: CoordinationTeamCurrent; workers: Array<CoordinationWorkerCurrent & { nonterminalTaskIds: string[] }>; tasks: CanonicalTaskCard[]; taskProjectionWarnings?: TaskCardWarning[] }
  | { kind: "no_active_team" }
  | { kind: "unavailable"; reason: "no_active_team" | "team_state_unavailable" | "task_authority_unavailable"; message: string }
  | { kind: "contract_gap"; reason: "team_epoch_missing" | "logical_workers_missing" | "task_metadata_absent" | "task_metadata_invalid" | "structured_task_event_evidence_absent"; message: string };

export type CoordinationSyncResult =
  | { kind: "snapshot"; team: CoordinationTeamCurrent; workers: Array<CoordinationWorkerCurrent & { nonterminalTaskIds: string[] }>; tasks: CanonicalTaskCard[]; taskProjectionWarnings?: TaskCardWarning[]; head: number; epochId: string }
  | { kind: "updates"; teamChanges: Array<{ kind: "created" | "lifecycle" | "purpose"; text: string }>; workerChanges: Array<{ worker: string; scope: string; kind: "created" | "connected" | "stopped" | "failed" | "scope_changed"; text: string }>; taskChanges: Array<{ taskId: string; changeKinds: Array<"created" | "goal" | "assignment" | "progress" | "status" | "relation">; journalEntries: ModelToolTaskJournalEntry[]; current: CanonicalTaskCard }>; taskProjectionWarnings?: TaskCardWarning[]; alerts: []; head: number; epochId: string }
  | { kind: "caught_up"; head: number; epochId: string }
  | { kind: "indeterminate"; message: string }
  | { kind: "snapshot_required"; message: string }
  | { kind: "cancelled"; message: string }
  | { kind: "contract_gap"; reason: "team_epoch_missing" | "logical_workers_missing" | "task_metadata_absent" | "task_metadata_invalid" | "structured_task_event_evidence_absent"; message: string }
  | { kind: "unavailable"; reason: "no_active_team" | "team_state_unavailable" | "task_authority_unavailable"; message: string };

export interface CoordinationPendingPresentation {
  sessionId: string;
  toolCallId: string;
  resultText: string;
  resultDigest: string;
  head: number;
  epochId: string;
}

/** A branch-local durable observation coordinate. */
export interface CoordinationObservationBinding {
  teamName: string;
  epochId: string;
  exactSessionFile: string;
  branchLineage: string[];
}

/** Pending model presentation is not Coordination authority. */
export interface CoordinationPendingObservation<TResult = unknown> {
  sessionId: string;
  toolCallId: string;
  resultText: string;
  resultDigest: string;
  head: number;
  epochId: string;
  result: TResult;
}

export interface CoordinationTaskProjection {
  tasks: CanonicalTaskCard[];
  warnings: TaskCardWarning[];
}

/** Stable Coordination result coordinates. Consumer projections may alias these shapes. */
export type CoordinationObservationResult<TResult = unknown> = TResult;
