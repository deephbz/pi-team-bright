import type { TaskAuthorityRecordEnvelope, TaskMetadata, CreateTaskInput, TaskAuthorityRecord } from "../utils/beads";
import {
  BeadsError,
  TASK_METADATA_KEY,
  TASK_METADATA_SCHEMA,
  assertTaskMetadataContext,
} from "../utils/beads";
import type { TeamEvent } from "../coordination/contracts";
import {
  projectTaskEventEvidence,
  type TaskEventEvidenceKind,
  type TaskEventEvidenceInput,
} from "../utils/team-events";
import {
  applySemanticTaskUpdate,
  createTask,
  listTaskIds,
  readTaskAuthorityRecordEnvelope,
  readTaskAuthorityRecordEnvelopes,
  mutateTaskLink,
  type AgentMutationBinding,
  type InternalTaskPublicationOptions,
  type TaskCreateReceipt,
  type SemanticTaskUpdateResult,
  type TaskMutationReceipt,
  type TaskMutationPublicationPort,
} from "./beads-authority-adapter";
import type { TaskAuthorityTeamPort } from "../task-authority/contracts";
import type {
  ModelToolTaskJournalEntry,
  ModelToolTaskUpdateInput,
} from "../task-authority/contracts";
import type { TaskWriteOptions } from "../utils/beads";
import { taskVersionRef, type TaskVersionRef } from "../task-authority/task-version-ref";
import {
  TASK_CARD_CONTEXT_MAX_LENGTH,
  TASK_CARD_GOAL_MAX_LENGTH,
  TASK_CARD_TITLE_MAX_LENGTH,
  type TaskCard,
  type TaskCardWarning,
} from "../task-authority/task-domain";

const INITIAL_CURRENT_CONTEXT = "Work has not started.";
const JOURNAL_KINDS = new Set<TaskEventEvidenceKind>([
  "progress",
  "decision",
  "blocker",
  "result",
  "note",
]);

export type TaskProjectionGapReason =
  | "task_metadata_absent"
  | "task_metadata_invalid";

export interface TaskProjectionGap {
  kind: "contract_gap";
  reason: TaskProjectionGapReason;
  taskId: string;
  version: TaskVersionRef;
  message: string;
}

export type TaskReadOutcome =
  | { kind: "found"; task: TaskCard }
  | TaskProjectionGap;

export type TaskCreateOutcome =
  | { kind: "created"; operationId: string; task: TaskCard; deliveryWarnings: string[] }
  | { kind: "operation_conflict"; operationId: string; message: string }
  | { kind: "unknown_outcome"; operationId: string; message: string };

export interface TaskLinkInput {
  taskId: string;
  relation: "blocked_by" | "parent" | "related";
  targetId: string;
  action: "add" | "remove";
  expectedVersion?: TaskVersionRef;
}

export type TaskLinkOutcome =
  | { kind: "linked"; taskId: string; targetId: string; relation: TaskLinkInput["relation"]; action: TaskLinkInput["action"]; changed: boolean; version: TaskVersionRef }
  | { kind: "refused"; taskId: string; reason: "task_not_found" | "version_conflict" | "graph_conflict"; message: string }
  | { kind: "unavailable"; reason: "task_authority_unavailable"; message: string };

export type TaskUpdateOutcome =
  | {
    kind: "updated";
    taskId: string;
    operationId: string;
    task: TaskCard;
    journalEntries: ModelToolTaskJournalEntry[];
  }
  | {
    kind: "refused";
    reason: "version_conflict" | "operation_conflict";
    taskId: string;
    operationId: string;
    currentTask: TaskCard;
    message: string;
  }
  | {
    kind: "contract_gap";
    reason: "external_writer_atomicity_unavailable";
    taskId: string;
    operationId: string;
    currentTask: TaskCard;
    unsupported: readonly ["atomic_compare_and_swap", "task_scoped_operation_replay"];
    message: string;
  }
  | TaskProjectionGap;

type TaskAuthorityUpdateInput = Omit<ModelToolTaskUpdateInput, "expectedVersion"> & {
  expectedVersion: string;
  claim?: boolean;
};

export interface TaskAdapterAuthority {
  create?(input: CreateTaskInput, publication: InternalTaskPublicationOptions): Promise<TaskCreateReceipt>;
  read(taskId: string): Promise<TaskAuthorityRecordEnvelope>;
  /** Batch Task hydration over the existing native multi-ID show seam. */
  readMany?(taskIds: readonly string[]): Promise<Array<TaskAuthorityRecordEnvelope | undefined>>;
  update?(taskId: string, input: TaskAuthorityUpdateInput, metadata: TaskMetadata): Promise<SemanticTaskUpdateResult>;
  link?(taskId: string, input: TaskLinkInput, options: TaskWriteOptions & AgentMutationBinding): Promise<TaskMutationReceipt>;
}

export interface TaskChangeProjection {
  taskId: string;
  changeKinds: Array<"created" | "goal" | "assignment" | "progress" | "status" | "relation">;
  journalEntries: ModelToolTaskJournalEntry[];
  current: TaskCard;
}

export type TaskChangesOutcome =
  | { kind: "projected"; changes: TaskChangeProjection[] }
  | {
    kind: "contract_gap";
    reason: "structured_task_event_evidence_absent";
    taskId: string;
    eventId: string;
    message: string;
  };

function taskMetadata(goal: string, currentContext: string, lastOperation?: TaskMetadata["last_operation"]): TaskMetadata {
  assertTaskMetadataContext({ current_context: currentContext });
  return {
    schema: TASK_METADATA_SCHEMA,
    goal,
    current_context: currentContext,
    ...(lastOperation ? { last_operation: lastOperation } : {}),
  };
}

/** Refresh Worker-visible context without discarding the durable replay record. */
export function refreshTaskMetadata(
  metadata: TaskMetadata,
  currentContext: string,
): TaskMetadata {
  return taskMetadata(metadata.goal, currentContext, metadata.last_operation);
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
  task: TaskAuthorityRecord,
  reason: TaskProjectionGapReason,
  message: string,
): TaskProjectionGap {
  return {
    kind: "contract_gap",
    reason,
    taskId: task.id,
    version: taskVersionRef(task.version),
    message,
  };
}

export function parseTaskMetadata(record: TaskAuthorityRecordEnvelope): TaskMetadata | TaskProjectionGap {
  if (record.taskMetadata === undefined) {
    return projectionGap(
      record.task,
      "task_metadata_absent",
      `Task ${record.task.id} has no canonical ${TASK_METADATA_KEY} metadata; compatibility fields are not a Task definition.`,
    );
  }
  let value = record.taskMetadata;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return projectionGap(
        record.task,
        "task_metadata_invalid",
        `Task ${record.task.id} has malformed canonical ${TASK_METADATA_KEY} metadata.`,
      );
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return projectionGap(
      record.task,
      "task_metadata_invalid",
      `Task ${record.task.id} has non-object canonical ${TASK_METADATA_KEY} metadata.`,
    );
  }
  const metadata = value as Record<string, unknown>;
  if (
    metadata.schema !== TASK_METADATA_SCHEMA
    || typeof metadata.goal !== "string"
    || metadata.goal.length === 0
    || typeof metadata.current_context !== "string"
    || metadata.current_context.length === 0
  ) {
    return projectionGap(
      record.task,
      "task_metadata_invalid",
      `Task ${record.task.id} has unsupported or incomplete canonical ${TASK_METADATA_KEY} metadata.`,
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
    ? operationRecord as unknown as TaskMetadata["last_operation"]
    : undefined;
  if (operation !== undefined && !validOperation) {
    return projectionGap(
      record.task,
      "task_metadata_invalid",
      `Task ${record.task.id} has malformed Task operation metadata.`,
    );
  }
  return {
    schema: TASK_METADATA_SCHEMA,
    goal: metadata.goal,
    current_context: metadata.current_context,
    ...(validOperation ? { last_operation: validOperation } : {}),
  };
}

function projectTask(task: TaskAuthorityRecord, metadata: TaskMetadata): TaskCard {
  const truncated: TaskCardWarning["truncated_fields"] = [];
  const incomplete: TaskCardWarning["incomplete_fields"] = [];
  const title = task.title.length > TASK_CARD_TITLE_MAX_LENGTH
    ? `${task.title.slice(0, TASK_CARD_TITLE_MAX_LENGTH - 1)}…`
    : task.title;
  if (title !== task.title) truncated.push("title");
  const context = metadata.current_context.length > TASK_CARD_CONTEXT_MAX_LENGTH
    ? `${metadata.current_context.slice(0, TASK_CARD_CONTEXT_MAX_LENGTH - 1)}…`
    : metadata.current_context;
  if (context !== metadata.current_context) truncated.push("current_context");
  const warning = (): TaskCardWarning | undefined => truncated.length || incomplete.length
    ? {
      task_id: task.id,
      truncated_fields: [...truncated],
      incomplete_fields: [...incomplete],
      message: "Some Task meaning exceeds the bounded display contract; review the current authority record before acting.",
    }
    : undefined;
  const base = {
    id: task.id,
    title,
    status: task.status,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    current_context: context,
    version: taskVersionRef(task.version),
  };
  if (metadata.goal.length > TASK_CARD_GOAL_MAX_LENGTH) {
    incomplete.push("goal");
    return { ...base, goal_state: "incomplete", projection_warnings: [warning()!] };
  }
  const taskWarning = warning();
  return taskWarning
    ? { ...base, goal: metadata.goal, projection_warnings: [taskWarning] }
    : { ...base, goal: metadata.goal };
}

/** Project one raw authority envelope into the canonical TaskCard boundary. */
export function projectTaskCard(record: TaskAuthorityRecordEnvelope): TaskCard | TaskProjectionGap {
  const metadata = parseTaskMetadata(record);
  return "kind" in metadata ? metadata : projectTask(record.task, metadata);
}

function projectTaskRecord(record: TaskAuthorityRecordEnvelope): TaskReadOutcome {
  const projected = projectTaskCard(record);
  return "kind" in projected ? projected : { kind: "found", task: projected };
}

/** Read the canonical post-state evidence needed by delivery recovery. */
export async function readTaskOwnerTransitionEvidence(
  teamName: string,
  taskId: string,
): Promise<{ task: TaskCard; operationId?: string }> {
  const record = await readTaskAuthorityRecordEnvelope(teamName, taskId);
  const card = projectTaskCard(record);
  if ("kind" in card) {
    const error = new Error(card.message);
    error.name = "upgrade_required";
    throw error;
  }
  return {
    task: card,
    ...(record.ownerTransitionOperationId ? { operationId: record.ownerTransitionOperationId } : {}),
  };
}

function readOnlyAuthority(teamName: string): TaskAdapterAuthority {
  return {
    read: (taskId) => readTaskAuthorityRecordEnvelope(teamName, taskId),
    readMany: (taskIds) => readTaskAuthorityRecordEnvelopes(teamName, taskIds),
  };
}

function publishingAuthority(
  teamName: string,
  actor: string,
  publicationPort: TaskMutationPublicationPort,
  teamPort?: TaskAuthorityTeamPort,
): TaskAdapterAuthority {
  return {
    ...readOnlyAuthority(teamName),
    create: (input, publication) => createTask(teamName, input, publicationPort, { actor }, {
      ...publication,
      taskCardProjector: projectTaskCard,
    }, teamPort),
    update: (taskId, input, metadata) => applySemanticTaskUpdate(teamName, taskId, {
      ...(input.claim ? { claim: true } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.journalEntries?.length ? { appendNote: input.journalEntries.map((entry) => `[${entry.kind}] ${entry.text}`).join("\\n") } : {}),
    }, {
      actor,
      expectedVersion: input.expectedVersion,
      taskMetadata: metadata,
      taskCardProjector: projectTaskCard,
      taskEventEvidence: taskUpdateEventEvidence(input as ModelToolTaskUpdateInput),
    }, publicationPort, teamPort),
    link: (taskId, input, options) => mutateTaskLink(teamName, taskId, {
      relation: input.relation,
      targetId: input.targetId,
      action: input.action,
    }, { ...options, taskCardProjector: projectTaskCard }, publicationPort, teamPort),
  };
}

export type BeadsTaskAdapterFactory = (teamName: string, actor: string) => BeadsTaskAdapter;

export function createPublishingBeadsTaskAdapterFactory(
  publicationPort: TaskMutationPublicationPort,
  teamPort?: TaskAuthorityTeamPort,
): BeadsTaskAdapterFactory {
  return (teamName, actor) => new BeadsTaskAdapter(
    teamName,
    actor,
    publishingAuthority(teamName, actor, publicationPort, teamPort),
  );
}

/**
 * Unregistered Task projection over the existing Beads authority.
 *
 * Create and read are durable. Update fails closed until the authority can
 * prove external-writer compare-and-swap and Task-scoped operation replay.
 */
export class BeadsTaskAdapter {
  private readonly authority: TaskAdapterAuthority;

  constructor(
    readonly teamName: string,
    readonly actor: string,
    authority: TaskAdapterAuthority = readOnlyAuthority(teamName),
  ) {
    this.authority = authority;
  }

  async create(input: { operationId: string; title: string; goal: string; assignee?: string }): Promise<TaskCreateOutcome> {
    return this.createWithReceipt(input);
  }

  async createWithReceipt(input: { operationId: string; title: string; goal: string; assignee?: string }): Promise<TaskCreateOutcome> {
    const metadata = taskMetadata(input.goal, INITIAL_CURRENT_CONTEXT);
    try {
      const create = this.authority.create;
      if (!create) {
        return {
          kind: "unknown_outcome",
          operationId: input.operationId,
          message: "Task create outcome is unknown: the Task adapter is read-only.",
        };
      }
      const receipt = await create({
        title: input.title,
        // These are compatibility projections only. Task reads use metadata.
        description: input.goal,
        ...(input.assignee ? { acceptanceCriteria: input.goal, assignee: input.assignee } : {}),
        internalMetadata: { [TASK_METADATA_KEY]: metadata },
        // Beads persists this Team-scoped opaque operation coordinate with the
        // create itself. It is never derived from Task content or tool-call ID.
        idempotencyKey: `model-task-create:${this.teamName}:${input.operationId}`,
      }, {
        taskEventEvidence: [{ kind: "created", text: input.goal }],
        taskMetadata: metadata,
        taskCardProjector: projectTaskCard,
      });
      // Real authority receipts carry the exact post-state card. The read is
      // only a compatibility seam for injected authorities that predate it.
      const record = receipt.taskCard
        ? { task: receipt.task, taskMetadata: metadata }
        : receipt.taskEnvelope ?? await this.authority.read(receipt.task.id);
      const parsed = parseTaskMetadata(record);
      const matches = !("kind" in parsed)
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
        task: receipt.taskCard ?? projectTask(record.task, parsed),
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

  async read(taskId: string): Promise<TaskReadOutcome> {
    const record = await this.authority.read(taskId);
    return projectTaskRecord(record);
  }

  /** Resolve one public version coordinate to raw CAS, then retain that CAS for the mutation. */
  async link(input: TaskLinkInput, binding: Omit<AgentMutationBinding, "actor"> = {}): Promise<TaskLinkOutcome> {
    try {
      let expectedVersion: string | undefined;
      if (input.expectedVersion !== undefined) {
        const record = await this.authority.read(input.taskId);
        expectedVersion = record.task.version;
        if (taskVersionRef(expectedVersion) !== input.expectedVersion) {
          return {
            kind: "refused",
            taskId: input.taskId,
            reason: "version_conflict",
            message: "The supplied Task version ref is stale; read the current Task before retrying.",
          };
        }
      }
      if (!this.authority.link) {
        return {
          kind: "unavailable",
          reason: "task_authority_unavailable",
          message: "The Task authority does not expose the conditional link capability.",
        };
      }
      const result = await this.authority.link(input.taskId, input, {
        actor: this.actor,
        expectedVersion,
        ...binding,
      });
      return {
        kind: "linked",
        taskId: input.taskId,
        targetId: input.targetId,
        relation: input.relation,
        action: input.action,
        changed: result.changed,
        version: taskVersionRef(result.task.version),
      };
    } catch (error) {
      if (error instanceof BeadsError) {
        const message = error.message;
        const reason = /not found|no issue found/i.test(message)
          ? "task_not_found" as const
          : /changed since version|expected(?: Task)? version|stale/i.test(message)
            ? "version_conflict" as const
            : "graph_conflict" as const;
        return { kind: "refused", taskId: input.taskId, reason, message };
      }
      return { kind: "unavailable", reason: "task_authority_unavailable", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Project all Task records without changing gap or version semantics. */
  async readMany(taskIds: readonly string[]): Promise<Array<TaskReadOutcome | undefined>> {
    const records = this.authority.readMany
      ? await this.authority.readMany(taskIds)
      : await Promise.all(taskIds.map((taskId) => this.authority.read(taskId)));
    return records.map((record) => record ? projectTaskRecord(record) : undefined);
  }

  async list(): Promise<TaskCard[]> {
    const results = await this.readMany(await listTaskIds(this.teamName));
    return results.flatMap((result) => result && result.kind === "found" ? [result.task] : []);
  }

  async claim(input: { taskId: string; operationId: string; expectedVersion: TaskVersionRef }): Promise<TaskUpdateOutcome> {
    return this.update({ ...input, claim: true } as ModelToolTaskUpdateInput & { claim: true });
  }

  async update(input: ModelToolTaskUpdateInput & { claim?: boolean }): Promise<TaskUpdateOutcome> {
    const record = await this.authority.read(input.taskId);
    const metadata = parseTaskMetadata(record);
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
        reason: "external_writer_atomicity_unavailable",
        taskId: input.taskId,
        operationId: input.operationId,
        currentTask,
        unsupported: ["atomic_compare_and_swap", "task_scoped_operation_replay"],
        message: "The Task authority does not expose the conditional update capability.",
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
    let nextMetadata: TaskMetadata;
    try {
      nextMetadata = taskMetadata(metadata.goal, input.currentContext ?? metadata.current_context, operation);
    } catch (error) {
      return projectionGap(
        record.task,
        "task_metadata_invalid",
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      const result = await this.authority.update(input.taskId, {
        ...input,
        expectedVersion: record.task.version,
      }, nextMetadata);
      return {
        kind: "updated",
        taskId: input.taskId,
        operationId: input.operationId,
        task: result.taskCard ?? projectTask(result.task, nextMetadata),
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
export function projectNonterminalTaskIds(
  tasks: readonly TaskCard[],
  workerName: string,
): string[] {
  return tasks
    .filter((task) => task.assignee === workerName && task.status !== "closed")
    .map((task) => task.id)
    .sort();
}

export function projectTaskJournalEntry(event: TeamEvent): ModelToolTaskJournalEntry | undefined {
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

function changeKind(event: TeamEvent): TaskChangeProjection["changeKinds"][number] | undefined {
  if (event.type !== "task") return undefined;
  const evidence = projectTaskEventEvidence(event);
  if (evidence) {
    if (JOURNAL_KINDS.has(evidence.kind)) return "progress";
    if (["created", "goal", "assignment", "status", "relation"].includes(evidence.kind)) {
      return evidence.kind as TaskChangeProjection["changeKinds"][number];
    }
  }
  if (event.change === "created") return "created";
  if (event.change === "assigned") return "assignment";
  if (event.change === "status") return "status";
  if (event.change === "relation") return "relation";
  return undefined;
}

/** Group committed Task evidence and attach one latest canonical current state. */
export function projectTaskChanges(
  events: readonly TeamEvent[],
  currentTasks: readonly TaskCard[],
): TaskChangesOutcome {
  const currentById = new Map(currentTasks.map((task) => [task.id, task]));
  const grouped = new Map<string, Omit<TaskChangeProjection, "current">>();
  for (const event of events) {
    if (event.type !== "task") continue;
    const task = currentById.get(event.ref.taskId);
    if (!task) continue;
    // Structural Task events remain useful without narrative evidence. Only
    // evidence-backed entries contribute journal content below.
    if (!projectTaskEventEvidence(event)) {
      if (event.change === "note") {
        return {
          kind: "contract_gap",
          reason: "structured_task_event_evidence_absent",
          taskId: task.id,
          eventId: `task-event-${event.cursor}`,
          message: `Task event ${event.cursor} has no structured actor/kind/text evidence; Task updates cannot reconstruct it safely.`,
        };
      }
      if (!changeKind(event)) continue;
    }
    const group = grouped.get(task.id) ?? { taskId: task.id, changeKinds: [], journalEntries: [] };
    const kind = changeKind(event);
    if (kind && !group.changeKinds.includes(kind)) group.changeKinds.push(kind);
    const journalEntry = projectTaskJournalEntry(event);
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
        current: task,
      }];
    }),
  };
}

/** Construct update publication evidence without inventing identity or time. */
export function taskUpdateEventEvidence(input: ModelToolTaskUpdateInput): TaskEventEvidenceInput[] {
  return (input.journalEntries ?? []).map((entry) => ({ kind: entry.kind, text: entry.text }));
}
