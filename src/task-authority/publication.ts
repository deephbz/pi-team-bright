import type { CanonicalTaskCard } from "./task-domain";
import type { TaskVersionRef } from "./task-version-ref";

/** Committed Task evidence crosses into Coordination and delivery through this port. */
export type TaskMutationChangeKind =
  | "assigned"
  | "ownership_lost"
  | "status_changed"
  | "relation_changed"
  | "note_appended"
  | "task_changed";

export type TaskMutationEventEvidenceKind =
  | "created"
  | "goal"
  | "assignment"
  | "progress"
  | "status"
  | "relation"
  | "decision"
  | "blocker"
  | "result"
  | "note";

export interface TaskMutationEventEvidenceInput {
  kind: TaskMutationEventEvidenceKind;
  text: string;
}

export type TaskMutationCoordinates = {
  id: string;
  title: string;
  status: CanonicalTaskCard["status"];
  assignee?: string;
  version: TaskVersionRef;
};

export interface TaskMutationPublicationInput {
  teamName: string;
  before: TaskMutationCoordinates;
  after: TaskMutationCoordinates;
  created: boolean;
  kind: TaskMutationChangeKind;
  actor?: string;
  taskEventEvidence: readonly TaskMutationEventEvidenceInput[];
  deliver: boolean;
  taskCard?: CanonicalTaskCard;
}

export interface TaskOwnerTransitionPreparationInput {
  operationId: string;
  teamName: string;
  before: CanonicalTaskCard;
  afterOwner?: string;
  previousOperationId?: string;
}

export interface TaskMutationSuppressionInput {
  teamName: string;
  recipient: string;
  sessionFile: string;
  task: CanonicalTaskCard | TaskMutationCoordinates;
}

export interface TaskOwnerTransitionCompletionInput {
  teamName: string;
  operationId: string;
  task: CanonicalTaskCard;
}

export interface TaskMutationPublicationRecoveryInput {
  teamName: string;
  taskId: string;
  taskVersion: TaskVersionRef;
  /** Legacy operation evidence follows a Task across versions; graph evidence requires the exact committed version. */
  versionScope?: "task" | "task_version";
  evidenceKind: "created" | "relation" | "goal" | "status" | "note" | "blocker" | "decision" | "result";
  evidenceText: string;
}

export interface TaskMutationPublicationPort {
  prepareOwnerTransitionIntent(input: TaskOwnerTransitionPreparationInput): Promise<boolean>;
  suppressTaskVersionForSession(input: TaskMutationSuppressionInput): Promise<void>;
  publishTaskMutation(input: TaskMutationPublicationInput): Promise<{ warnings: string[]; evidence: TaskPublicationEvidence }>;
  completeOwnerTransitionIntent(input: TaskOwnerTransitionCompletionInput): Promise<string[]>;
  /** Optional recovery query used after an atomic graph receipt is replayed. */
  hasTaskMutationPublication?(input: TaskMutationPublicationRecoveryInput): Promise<boolean>;
}

export interface TaskPublicationEvidence {
  teamEvent: { appended: boolean };
  delivery: {
    attemptedRecipients: string[];
    failedRecipients: string[];
    recoveryRecordedFor: string[];
    recoveryRecordFailedFor: string[];
  };
}
