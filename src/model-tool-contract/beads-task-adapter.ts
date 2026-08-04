import type { CandidateTaskAuthorityRecord, CandidateTaskMetadata, CreateTaskInput } from "../utils/beads";
import {
  BeadsError,
  CANDIDATE_TASK_METADATA_KEY,
  CANDIDATE_TASK_CURRENT_CONTEXT_MAX_LENGTH,
  CANDIDATE_TASK_GOAL_MAX_LENGTH,
  CANDIDATE_TASK_METADATA_SCHEMA,
  assertCandidateTaskMetadataContext,
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
  readCandidateTaskAuthorityRecords,
  type InternalTaskPublicationOptions,
  type TaskCreateReceipt,
  type SemanticTaskUpdateResult,
} from "../utils/tasks";
import type {
  ModelToolTaskCurrent,
  ModelToolTaskJournalEntry,
  ModelToolTaskProjectionWarning,
  ModelToolTaskUpdateInput,
} from "./in-memory-team-port";
import { taskVersionRef } from "./task-version-ref";
import { MODEL_TOOL_CANDIDATE_LIMITS } from "./catalog";

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
  projectionWarning?: ModelToolTaskProjectionWarning;
}

export type CandidateTaskReadOutcome =
  | { kind: "found"; task: ModelToolTaskCurrent }
  | CandidateTaskProjectionGap;

export type CandidateTaskCreateOutcome =
  | { kind: "created"; operationId: string; task: ModelToolTaskCurrent; deliveryWarnings: string[] }
  | { kind: "operation_conflict"; operationId: string; message: string }
  | { kind: "unknown_outcome"; operationId: string; message: string };

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
  /** Batch candidate hydration over the existing native multi-ID show seam. */
  readMany?(taskIds: readonly string[]): Promise<CandidateTaskAuthorityRecord[]>;
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
    projection_warnings?: ModelToolTaskProjectionWarning[];
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
  assertCandidateTaskMetadataContext({ current_context: currentContext });
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
    ...(input.currentContext !== undefined ? { currentContext: input.currentContext } : {}),
    ...(input.journalEntries !== undefined ? { journalEntries: input.journalEntries } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  });
}

function projectionGap(
  task: TaskFile,
  reason: CandidateTaskProjectionGapReason,
  message: string,
  projectionWarning?: ModelToolTaskProjectionWarning,
): CandidateTaskProjectionGap {
  return {
    kind: "contract_gap",
    reason,
    taskId: task.id,
    authorityVersion: task.version,
    message,
    ...(projectionWarning ? { projectionWarning } : {}),
  };
}

const MAX_TASK_TITLE = MODEL_TOOL_CANDIDATE_LIMITS.maxTaskTitleChars;
const MAX_TASK_GOAL = CANDIDATE_TASK_GOAL_MAX_LENGTH;
const MAX_TASK_CONTEXT = CANDIDATE_TASK_CURRENT_CONTEXT_MAX_LENGTH;

function displayValue(value: string, max: number): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  if (max <= 1) return { value: "…", truncated: true };
  let end = max - 1;
  // Keep the bounded display valid UTF-16 while counting the same JavaScript
  // string units as the TypeBox maxLength contract.
  if (end > 0 && end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end -= 1;
  return { value: `${value.slice(0, end)}…`, truncated: true };
}

function projectionWarning(
  task: TaskFile,
  truncatedFields: ModelToolTaskProjectionWarning["truncated_fields"],
  incompleteFields: ModelToolTaskProjectionWarning["incomplete_fields"],
  message: string,
): ModelToolTaskProjectionWarning {
  return { task_id: task.id, truncated_fields: truncatedFields, incomplete_fields: incompleteFields, message };
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
  const title = displayValue(task.title, MAX_TASK_TITLE);
  const context = displayValue(metadata.current_context, MAX_TASK_CONTEXT);
  const truncatedFields: ModelToolTaskProjectionWarning["truncated_fields"] = [];
  const incompleteFields: ModelToolTaskProjectionWarning["incomplete_fields"] = [];
  if (title.truncated) truncatedFields.push("title");
  if (context.truncated) truncatedFields.push("current_context");
  const goalIncomplete = metadata.goal.length > MAX_TASK_GOAL;
  if (goalIncomplete) incompleteFields.push("goal");
  const warning = truncatedFields.length > 0 || incompleteFields.length > 0
    ? projectionWarning(task, truncatedFields, incompleteFields, goalIncomplete
      ? "The executable goal is incomplete in this model projection; the authority record was not changed."
      : "One or more external display fields were truncated for the model projection; the authority record was not changed.")
    : undefined;
  const structural = {
    id: task.id,
    title: title.value,
    status: task.status,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    current_context: context.value,
    version: task.version,
  };
  if (goalIncomplete) {
    return {
      ...structural,
      goal_state: "incomplete",
      projection_warnings: [warning!],
    };
  }
  return {
    ...structural,
    goal: metadata.goal,
    ...(warning ? { projection_warnings: [warning] } : {}),
  };
}

function projectCandidateTaskRecord(record: CandidateTaskAuthorityRecord): CandidateTaskReadOutcome {
  const metadata = parseCandidateTaskMetadata(record);
  if ("kind" in metadata) return metadata;
  return { kind: "found", task: projectTask(record.task, metadata) };
}

function defaultAuthority(teamName: string, actor: string): CandidateTaskAdapterAuthority {
  return {
    create: (input, publication) => createTask(teamName, input, { actor }, publication),
    read: (taskId) => readCandidateTaskAuthorityRecord(teamName, taskId),
    readMany: (taskIds) => readCandidateTaskAuthorityRecords(teamName, taskIds),
    update: (taskId, input, metadata) => applySemanticTaskUpdate(teamName, taskId, {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.journalEntries?.length ? { appendNote: input.journalEntries.map((entry) => `[${entry.kind}] ${entry.text}`).join("\\n") } : {}),
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

  async create(input: { operationId: string; title: string; goal: string; assignee?: string }): Promise<CandidateTaskCreateOutcome> {
    return this.createWithReceipt(input);
  }

  async createWithReceipt(input: { operationId: string; title: string; goal: string; assignee?: string }): Promise<CandidateTaskCreateOutcome> {
    const metadata = candidateMetadata(input.goal, INITIAL_CURRENT_CONTEXT);
    try {
      const receipt = await this.authority.create({
        title: input.title,
        // These are compatibility projections only. Candidate reads use metadata.
        description: input.goal,
        ...(input.assignee ? { acceptanceCriteria: input.goal, assignee: input.assignee } : {}),
        internalMetadata: { [CANDIDATE_TASK_METADATA_KEY]: metadata },
        // Beads persists this Team-scoped opaque operation coordinate with the
        // create itself. It is never derived from Task content or tool-call ID.
        idempotencyKey: `model-task-create:${this.teamName}:${input.operationId}`,
      }, {
        taskEventEvidence: [{ kind: "created", text: input.goal }],
      });
      const record = await this.authority.read(receipt.task.id);
      const parsed = parseCandidateTaskMetadata(record);
      const matches = !('kind' in parsed)
        && record.task.title === input.title
        && (record.task.assignee || undefined) === input.assignee
        && parsed.goal === input.goal
        && parsed.current_context === INITIAL_CURRENT_CONTEXT
        && parsed.last_operation === undefined;
      if (!matches) {
        return {
          kind: "operation_conflict",
          operationId: input.operationId,
          message: "The create operation ID already identifies a Task with different initial semantics.",
        };
      }
      return {
        kind: "created",
        operationId: input.operationId,
        task: projectTask(record.task, parsed),
        deliveryWarnings: receipt.deliveryWarnings,
      };
    } catch (error) {
      return {
        kind: "unknown_outcome",
        operationId: input.operationId,
        message: `Task create outcome is unknown after authority interaction: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async read(taskId: string): Promise<CandidateTaskReadOutcome> {
    const record = await this.authority.read(taskId);
    return projectCandidateTaskRecord(record);
  }

  /** Project all candidate records without changing gap or version semantics. */
  async readMany(taskIds: readonly string[]): Promise<CandidateTaskReadOutcome[]> {
    const records = this.authority.readMany
      ? await this.authority.readMany(taskIds)
      : await Promise.all(taskIds.map((taskId) => this.authority.read(taskId)));
    return records.map(projectCandidateTaskRecord);
  }

  async update(input: ModelToolTaskUpdateInput): Promise<CandidateTaskUpdateOutcome> {
    const record = await this.authority.read(input.taskId);
    const projected = projectCandidateTaskRecord(record);
    if (projected.kind === "contract_gap") return projected;
    const metadata = parseCandidateTaskMetadata(record);
    if ("kind" in metadata) return metadata;
    const currentTask = projected.task;
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
    if (taskVersionRef(currentTask.version) !== input.expectedVersion) {
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
    const journalEntries = (input.journalEntries ?? []).map((entry, index) => ({
      id: `journal-${input.taskId}-${input.operationId}-${index + 1}`,
      at,
      actor: this.actor,
      kind: entry.kind,
      text: entry.text,
    }));
    const operation = { operation_id: input.operationId, fingerprint, journal_entries: journalEntries };
    const nextMetadata = candidateMetadata(metadata.goal, input.currentContext ?? metadata.current_context, operation);
    try {
      const result = await this.authority.update(input.taskId, {
        ...input,
        expectedVersion: record.task.version,
      }, nextMetadata);
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
    // Structural Task events remain useful without narrative evidence. Only
    // journal meaning requires taskEvidence; never invent a journal entry.
    const kind = changeKind(event);
    if (!kind && !projectTaskEventEvidence(event)) {
      return {
        kind: "contract_gap",
        reason: "structured_task_event_evidence_absent",
        taskId: task.id,
        eventId: `task-event-${event.cursor}`,
        message: `Task event ${event.cursor} has no structured evidence for its narrative change; candidate updates cannot reconstruct it safely.`,
      };
    }
    const group = grouped.get(task.id) ?? { taskId: task.id, changeKinds: [], journalEntries: [] };
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
          ...(task.projection_warnings ? { projection_warnings: task.projection_warnings } : {}),
        },
      }];
    }),
  };
}

/** Construct update publication evidence without inventing identity or time. */
export function candidateUpdateEventEvidence(input: ModelToolTaskUpdateInput): TaskEventEvidenceInput[] {
  return (input.journalEntries ?? []).map((entry) => ({ kind: entry.kind, text: entry.text }));
}
