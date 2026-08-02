import type { CandidateTaskAuthorityRecord, CandidateTaskMetadata, CreateTaskInput } from "../utils/beads";
import {
  BeadsError,
  CANDIDATE_TASK_METADATA_KEY,
  CANDIDATE_TASK_METADATA_SCHEMA,
} from "../utils/beads";
import type { TaskFile, TeamEvent } from "../utils/models";
import {
  projectTaskEventEvidence,
  type TaskEventEvidenceKind,
  type TaskEventEvidenceInput,
} from "../utils/team-events";
import {
  applySemanticTaskUpdate,
  createTask,
  readCandidateTaskAuthorityRecord,
  type InternalTaskPublicationOptions,
  type TaskCreateReceipt,
  type SemanticTaskUpdateResult,
} from "../utils/tasks";
import type {
  ModelToolTaskCurrent,
  ModelToolTaskJournalEntry,
  ModelToolTaskUpdateInput,
} from "./in-memory-team-port";

const INITIAL_CURRENT_CONTEXT = "Work has not started.";
const JOURNAL_KINDS = new Set<TaskEventEvidenceKind>([
  "progress",
  "decision",
  "blocker",
  "result",
  "note",
]);

export type CandidateTaskProjectionGapReason =
  | "candidate_metadata_absent"
  | "candidate_metadata_invalid";

export interface CandidateTaskProjectionGap {
  kind: "contract_gap";
  reason: CandidateTaskProjectionGapReason;
  taskId: string;
  authorityVersion: string;
  message: string;
}

export type CandidateTaskReadOutcome =
  | { kind: "found"; task: ModelToolTaskCurrent }
  | CandidateTaskProjectionGap;

export type CandidateTaskUpdateOutcome =
  | {
    kind: "updated";
    taskId: string;
    operationId: string;
    task: ModelToolTaskCurrent;
    journalEntries: ModelToolTaskJournalEntry[];
  }
  | {
    kind: "refused";
    reason: "version_conflict" | "operation_conflict";
    taskId: string;
    operationId: string;
    currentTask: ModelToolTaskCurrent;
    message: string;
  }
  | {
    kind: "contract_gap";
    reason: "beads_external_writer_atomicity_unavailable";
    taskId: string;
    operationId: string;
    currentTask: ModelToolTaskCurrent;
    unsupported: readonly ["atomic_compare_and_swap", "task_scoped_operation_replay"];
    message: string;
  }
  | CandidateTaskProjectionGap;

export interface CandidateTaskAdapterAuthority {
  create(input: CreateTaskInput, publication: InternalTaskPublicationOptions): Promise<TaskCreateReceipt>;
  read(taskId: string): Promise<CandidateTaskAuthorityRecord>;
  update?(taskId: string, input: ModelToolTaskUpdateInput, metadata: CandidateTaskMetadata): Promise<SemanticTaskUpdateResult>;
}

export interface CandidateTaskChangeProjection {
  taskId: string;
  changeKinds: Array<"created" | "goal" | "assignment" | "progress" | "status" | "relation">;
  journalEntries: ModelToolTaskJournalEntry[];
  current: {
    status: ModelToolTaskCurrent["status"];
    assignee?: string;
    current_context: string;
    version: string;
  };
}

export type CandidateTaskChangesOutcome =
  | { kind: "projected"; changes: CandidateTaskChangeProjection[] }
  | {
    kind: "contract_gap";
    reason: "structured_task_event_evidence_absent";
    taskId: string;
    eventId: string;
    message: string;
  };

function candidateMetadata(goal: string, currentContext: string, lastOperation?: CandidateTaskMetadata["last_operation"]): CandidateTaskMetadata {
  return {
    schema: CANDIDATE_TASK_METADATA_SCHEMA,
    goal,
    current_context: currentContext,
    ...(lastOperation ? { last_operation: lastOperation } : {}),
  };
}

/** Refresh Worker-visible context without discarding the durable replay record. */
export function refreshCandidateTaskMetadata(
  metadata: CandidateTaskMetadata,
  currentContext: string,
): CandidateTaskMetadata {
  return candidateMetadata(metadata.goal, currentContext, metadata.last_operation);
}

function updateFingerprint(input: ModelToolTaskUpdateInput): string {
  return JSON.stringify({
    taskId: input.taskId,
    expectedVersion: input.expectedVersion,
    currentContext: input.currentContext,
    journalEntries: input.journalEntries,
    status: input.status,
  });
}

function projectionGap(
  task: TaskFile,
  reason: CandidateTaskProjectionGapReason,
  message: string,
): CandidateTaskProjectionGap {
  return {
    kind: "contract_gap",
    reason,
    taskId: task.id,
    authorityVersion: task.version,
    message,
  };
}

export function parseCandidateTaskMetadata(record: CandidateTaskAuthorityRecord): CandidateTaskMetadata | CandidateTaskProjectionGap {
  if (record.candidateMetadata === undefined) {
    return projectionGap(
      record.task,
      "candidate_metadata_absent",
      `Task ${record.task.id} has no canonical ${CANDIDATE_TASK_METADATA_KEY} metadata; compatibility fields are not a candidate Task definition.`,
    );
  }
  let value = record.candidateMetadata;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return projectionGap(
        record.task,
        "candidate_metadata_invalid",
        `Task ${record.task.id} has malformed canonical ${CANDIDATE_TASK_METADATA_KEY} metadata.`,
      );
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return projectionGap(
      record.task,
      "candidate_metadata_invalid",
      `Task ${record.task.id} has non-object canonical ${CANDIDATE_TASK_METADATA_KEY} metadata.`,
    );
  }
  const metadata = value as Record<string, unknown>;
  if (
    metadata.schema !== CANDIDATE_TASK_METADATA_SCHEMA
    || typeof metadata.goal !== "string"
    || metadata.goal.length === 0
    || typeof metadata.current_context !== "string"
    || metadata.current_context.length === 0
  ) {
    return projectionGap(
      record.task,
      "candidate_metadata_invalid",
      `Task ${record.task.id} has unsupported or incomplete canonical ${CANDIDATE_TASK_METADATA_KEY} metadata.`,
    );
  }
  const operation = metadata.last_operation as unknown;
  const operationRecord = operation && typeof operation === "object" && !Array.isArray(operation)
    ? operation as Record<string, unknown>
    : undefined;
  const validOperation = operationRecord
    && typeof operationRecord.operation_id === "string"
    && typeof operationRecord.fingerprint === "string"
    && Array.isArray(operationRecord.journal_entries)
    && operationRecord.journal_entries.every((entry: unknown) => !!entry && typeof entry === "object"
      && typeof (entry as Record<string, unknown>).id === "string"
      && typeof (entry as Record<string, unknown>).at === "string"
      && typeof (entry as Record<string, unknown>).actor === "string"
      && JOURNAL_KINDS.has((entry as Record<string, unknown>).kind as TaskEventEvidenceKind)
      && typeof (entry as Record<string, unknown>).text === "string")
    ? operationRecord as unknown as CandidateTaskMetadata["last_operation"]
    : undefined;
  if (operation !== undefined && !validOperation) {
    return projectionGap(
      record.task,
      "candidate_metadata_invalid",
      `Task ${record.task.id} has malformed candidate operation metadata.`,
    );
  }
  return {
    schema: CANDIDATE_TASK_METADATA_SCHEMA,
    goal: metadata.goal,
    current_context: metadata.current_context,
    ...(validOperation ? { last_operation: validOperation } : {}),
  };
}

function projectTask(task: TaskFile, metadata: CandidateTaskMetadata): ModelToolTaskCurrent {
  return {
    id: task.id,
    title: task.title,
    goal: metadata.goal,
    status: task.status,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    current_context: metadata.current_context,
    version: task.version,
  };
}

function defaultAuthority(teamName: string, actor: string): CandidateTaskAdapterAuthority {
  return {
    create: (input, publication) => createTask(teamName, input, { actor }, publication),
    read: (taskId) => readCandidateTaskAuthorityRecord(teamName, taskId),
    update: (taskId, input, metadata) => applySemanticTaskUpdate(teamName, taskId, {
      status: input.status,
      appendNote: input.journalEntries.map((entry) => `[${entry.kind}] ${entry.text}`).join("\\n"),
    }, {
      actor,
      expectedVersion: input.expectedVersion,
      candidateTaskMetadata: metadata,
      taskEventEvidence: candidateUpdateEventEvidence(input),
    }),
  };
}

/**
 * Unregistered candidate Task projection over the existing Beads authority.
 *
 * Create and read are durable. Update fails closed until the authority can
 * prove external-writer compare-and-swap and Task-scoped operation replay.
 */
export class CandidateBeadsTaskAdapter {
  private readonly authority: CandidateTaskAdapterAuthority;

  constructor(
    readonly teamName: string,
    readonly actor: string,
    authority: CandidateTaskAdapterAuthority = defaultAuthority(teamName, actor),
  ) {
    this.authority = authority;
  }

  async create(input: { title: string; goal: string; assignee?: string }): Promise<ModelToolTaskCurrent> {
    const metadata = candidateMetadata(input.goal, INITIAL_CURRENT_CONTEXT);
    const receipt = await this.authority.create({
      title: input.title,
      // These are compatibility projections only. Candidate reads use metadata.
      description: input.goal,
      ...(input.assignee ? { acceptanceCriteria: input.goal, assignee: input.assignee } : {}),
      internalMetadata: { [CANDIDATE_TASK_METADATA_KEY]: metadata },
    }, {
      taskEventEvidence: [{ kind: "created", text: input.goal }],
    });
    return projectTask(receipt.task, metadata);
  }

  async read(taskId: string): Promise<CandidateTaskReadOutcome> {
    const record = await this.authority.read(taskId);
    const metadata = parseCandidateTaskMetadata(record);
    return "kind" in metadata ? metadata : { kind: "found", task: projectTask(record.task, metadata) };
  }

  async update(input: ModelToolTaskUpdateInput): Promise<CandidateTaskUpdateOutcome> {
    const record = await this.authority.read(input.taskId);
    const metadata = parseCandidateTaskMetadata(record);
    if ("kind" in metadata) return metadata;
    const currentTask = projectTask(record.task, metadata);
    const fingerprint = updateFingerprint(input);
    const prior = metadata.last_operation;
    if (prior && prior.operation_id === input.operationId) {
      if (prior.fingerprint !== fingerprint) {
        return {
          kind: "refused",
          reason: "operation_conflict",
          taskId: input.taskId,
          operationId: input.operationId,
          currentTask,
          message: "The operation ID was already used with different input.",
        };
      }
      return {
        kind: "updated",
        taskId: input.taskId,
        operationId: input.operationId,
        task: currentTask,
        journalEntries: prior.journal_entries,
      };
    }
    if (currentTask.version !== input.expectedVersion) {
      return {
        kind: "refused",
        reason: "version_conflict",
        taskId: input.taskId,
        operationId: input.operationId,
        currentTask,
        message: `Expected Task version ${input.expectedVersion}, but Beads reports ${currentTask.version}.`,
      };
    }
    if (!this.authority.update) {
      return {
        kind: "contract_gap",
        reason: "beads_external_writer_atomicity_unavailable",
        taskId: input.taskId,
        operationId: input.operationId,
        currentTask,
        unsupported: ["atomic_compare_and_swap", "task_scoped_operation_replay"],
        message: "The Task authority does not expose the conditional candidate update capability.",
      };
    }
    const at = new Date().toISOString();
    const journalEntries = input.journalEntries.map((entry, index) => ({
      id: `journal-${input.taskId}-${input.operationId}-${index + 1}`,
      at,
      actor: this.actor,
      kind: entry.kind,
      text: entry.text,
    }));
    const operation = { operation_id: input.operationId, fingerprint, journal_entries: journalEntries };
    const nextMetadata = candidateMetadata(metadata.goal, input.currentContext, operation);
    try {
      const result = await this.authority.update(input.taskId, input, nextMetadata);
      return {
        kind: "updated",
        taskId: input.taskId,
        operationId: input.operationId,
        task: projectTask(result.task, nextMetadata),
        journalEntries,
      };
    } catch (error) {
      if (error instanceof BeadsError && error.kind === "conflict") {
        const latest = await this.read(input.taskId);
        if (latest.kind === "found") {
          return { kind: "refused", reason: "version_conflict", taskId: input.taskId, operationId: input.operationId, currentTask: latest.task, message: error.message };
        }
      }
      throw error;
    }
  }
}

/** Derive Worker work from authoritative assignment and status; store no index. */
export function projectCandidateNonterminalTaskIds(
  tasks: readonly ModelToolTaskCurrent[],
  workerName: string,
): string[] {
  return tasks
    .filter((task) => task.assignee === workerName && task.status !== "closed")
    .map((task) => task.id)
    .sort();
}

export function projectCandidateTaskJournalEntry(event: TeamEvent): ModelToolTaskJournalEntry | undefined {
  const evidence = projectTaskEventEvidence(event);
  if (!evidence || !JOURNAL_KINDS.has(evidence.kind)) return undefined;
  return {
    id: evidence.id,
    at: evidence.at,
    actor: evidence.actor,
    kind: evidence.kind as ModelToolTaskJournalEntry["kind"],
    text: evidence.text,
  };
}

function changeKind(event: TeamEvent): CandidateTaskChangeProjection["changeKinds"][number] | undefined {
  if (event.type !== "task") return undefined;
  const evidence = projectTaskEventEvidence(event);
  if (evidence) {
    if (JOURNAL_KINDS.has(evidence.kind)) return "progress";
    if (["created", "goal", "assignment", "status", "relation"].includes(evidence.kind)) {
      return evidence.kind as CandidateTaskChangeProjection["changeKinds"][number];
    }
  }
  if (event.change === "created") return "created";
  if (event.change === "assigned") return "assignment";
  if (event.change === "status") return "status";
  if (event.change === "relation") return "relation";
  return undefined;
}

/** Group committed Task evidence and attach one latest canonical current state. */
export function projectCandidateTaskChanges(
  events: readonly TeamEvent[],
  currentTasks: readonly ModelToolTaskCurrent[],
): CandidateTaskChangesOutcome {
  const currentById = new Map(currentTasks.map((task) => [task.id, task]));
  const grouped = new Map<string, Omit<CandidateTaskChangeProjection, "current">>();
  for (const event of events) {
    if (event.type !== "task") continue;
    const task = currentById.get(event.ref.taskId);
    if (!task) continue;
    if (!projectTaskEventEvidence(event)) {
      return {
        kind: "contract_gap",
        reason: "structured_task_event_evidence_absent",
        taskId: task.id,
        eventId: `task-event-${event.cursor}`,
        message: `Task event ${event.cursor} has no structured actor/kind/text evidence; candidate updates cannot reconstruct it safely.`,
      };
    }
    const group = grouped.get(task.id) ?? { taskId: task.id, changeKinds: [], journalEntries: [] };
    const kind = changeKind(event);
    if (kind && !group.changeKinds.includes(kind)) group.changeKinds.push(kind);
    const journalEntry = projectCandidateTaskJournalEntry(event);
    if (journalEntry) group.journalEntries.push(journalEntry);
    grouped.set(task.id, group);
  }
  return {
    kind: "projected",
    changes: [...grouped.values()].flatMap((group) => {
      const task = currentById.get(group.taskId);
      if (!task || group.changeKinds.length === 0) return [];
      return [{
        ...group,
        current: {
          status: task.status,
          ...(task.assignee ? { assignee: task.assignee } : {}),
          current_context: task.current_context,
          version: task.version,
        },
      }];
    }),
  };
}

/** Construct update publication evidence without inventing identity or time. */
export function candidateUpdateEventEvidence(input: ModelToolTaskUpdateInput): TaskEventEvidenceInput[] {
  return input.journalEntries.map((entry) => ({ kind: entry.kind, text: entry.text }));
}
