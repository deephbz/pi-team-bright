// Project: pi-teams
import path from "node:path";
import crypto from "node:crypto";
import { BeadsAuthorityFingerprint, TeamConfig, type TaskEventChange } from "../utils/models";
import type { TaskAuthorityRecord } from "../utils/beads";
import {
  teamExists,
  readConfig,
  assertCurrentSessionBinding,
  withCurrentSessionBinding,
  assertNoOrphanedBeadsCutover,
} from "../utils/teams";
import {
  BeadsTaskStore,
  CreateTaskInput,
  type TaskMetadata,
  TaskWriteOptions,
  BeadsTaskStoreOptions,
  BeadsTaskLink,
  TaskAuthorityRecordEnvelope,
  TaskMutationResult,
  assertBeadsWorkspaceRoot,
  initializeBeadsWorkspace,
  readBeadsAuthorityFingerprint,
  assertBeadsAuthorityFingerprint,
} from "../utils/beads";
import { teamDir } from "../utils/paths";
import {
  completeOwnerTransitionIntent,
  enqueueTaskChangeForRecipient,
  prepareOwnerTransitionIntent,
  recordTaskDeliveryRecovery,
  suppressTaskVersionForSession,
  TaskChangeKind,
} from "../utils/task-delivery";
import { withSemanticTrace } from "../utils/trace";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import type { TaskCard } from "./task-domain";
import {
  appendTaskEvidenceEvent,
  type TaskEventEvidenceInput,
} from "../utils/team-events";

export const BEADS_WORKSPACE_ENV = "PI_TEAMS_BEADS_WORKSPACE";

/** Verify the configured native Task authority without exposing its store. */
export async function verifyTaskAuthority(config: TeamConfig): Promise<BeadsAuthorityFingerprint> {
  if (config.taskBackend !== "beads" || !config.taskWorkspace || !config.taskAuthorityFingerprint) {
    throw new Error(`Team ${config.name} has an incomplete Beads Task authority binding.`);
  }
  assertBeadsAuthorityFingerprint(config.taskWorkspace, config.taskAuthorityFingerprint);
  const store = new BeadsTaskStore({
    teamName: config.name,
    workspace: config.taskWorkspace,
    authorityFingerprint: config.taskAuthorityFingerprint,
    requireExpectedVersion: false,
  });
  return store.assertWorkspaceRoot();
}

export interface ResolvedTaskAuthority {
  workspace: string;
  authorityId: string;
  fingerprint: BeadsAuthorityFingerprint;
}

export function configuredBeadsWorkspace(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const workspace = env[BEADS_WORKSPACE_ENV]?.trim();
  if (!workspace) return undefined;
  if (!path.isAbsolute(workspace)) throw new Error(`${BEADS_WORKSPACE_ENV} must be an absolute path: ${workspace}`);
  return workspace;
}

/** Resolve one Team-owned Task authority for creation/reconnect. */
export async function resolveTeamTaskAuthority(teamName: string): Promise<ResolvedTaskAuthority> {
  if (teamExists(teamName)) {
    const existing = await readConfig(teamName);
    if (existing.taskBackend !== "beads" || !existing.taskWorkspace) {
      const target = process.env[BEADS_WORKSPACE_ENV]?.trim() || "<absolute-beads-workspace>";
      throw new Error(`Team ${teamName} still uses legacy JSON Task authority. Run: npm run migrate:tasks -- ${teamName} ${target}`);
    }
    if (!existing.taskAuthorityId || !existing.taskAuthorityFingerprint) {
      throw new Error(`Team ${teamName} has an incomplete Beads Task authority binding; restore taskAuthorityId and taskAuthorityFingerprint through an explicit recovery review.`);
    }
    assertBeadsWorkspaceRoot(existing.taskWorkspace);
    const store = new BeadsTaskStore({
      teamName,
      workspace: existing.taskWorkspace,
      authorityFingerprint: existing.taskAuthorityFingerprint,
      requireExpectedVersion: true,
    });
    await store.assertWorkspaceRoot();
    await store.list();
    return { workspace: existing.taskWorkspace, authorityId: existing.taskAuthorityId, fingerprint: existing.taskAuthorityFingerprint };
  }
  assertNoOrphanedBeadsCutover(teamName);
  const configuredWorkspace = configuredBeadsWorkspace();
  const workspace = configuredWorkspace || teamDir(teamName);
  const fingerprint = configuredWorkspace
    ? readBeadsAuthorityFingerprint(workspace)
    : await initializeBeadsWorkspace(workspace);
  const store = new BeadsTaskStore({ teamName, workspace, authorityFingerprint: fingerprint, requireExpectedVersion: true });
  await store.assertWorkspaceRoot();
  await store.list();
  return { workspace, authorityId: `task_authority_${crypto.randomUUID()}`, fingerprint };
}

async function storeFor(teamName: string): Promise<BeadsTaskStore> {
  const config = await readConfig(teamName);
  if (config.taskBackend !== "beads") {
    const target = process.env[BEADS_WORKSPACE_ENV]?.trim() || "<absolute-beads-workspace>";
    throw new Error(`Team ${teamName} still uses legacy JSON Task authority. Run: npm run migrate:tasks -- ${teamName} ${target}`);
  }
  if (!config.taskWorkspace) {
    throw new Error(`Team ${teamName} is configured for Beads but has no taskWorkspace. Re-run migration configuration; legacy task files are not a fallback.`);
  }
  if (!config.taskAuthorityId || !config.taskAuthorityFingerprint) {
    throw new Error(`Team ${teamName} has an incomplete Beads Task authority binding.`);
  }
  return new BeadsTaskStore({
    teamName,
    workspace: config.taskWorkspace!,
    authorityFingerprint: config.taskAuthorityFingerprint,
    requireExpectedVersion: false,
  });
}

function storeForConfig(config: TeamConfig): BeadsTaskStore {
  if (config.taskBackend !== "beads" || !config.taskWorkspace || !config.taskAuthorityId || !config.taskAuthorityFingerprint) {
    throw new Error(`Team ${config.name} has no complete Beads Task authority binding.`);
  }
  return new BeadsTaskStore({
    teamName: config.name,
    workspace: config.taskWorkspace,
    authorityFingerprint: config.taskAuthorityFingerprint,
    requireExpectedVersion: false,
  });
}

export interface AgentMutationBinding {
  actor: string;
  actingSessionFile?: string;
  actingMembershipId?: string;
  /** Adapter-owned projection of the committed raw authority envelope. */
  taskCardProjector?: (record: TaskAuthorityRecordEnvelope) => TaskCard | { kind: "contract_gap"; message: string };
}

export interface InternalTaskPublicationOptions {
  /** Structured evidence for internal Task writes. */
  taskEventEvidence?: readonly TaskEventEvidenceInput[];
  /** Canonical Task meaning carried to delivery without a read. */
  taskMetadata?: Pick<TaskMetadata, "goal" | "current_context">;
  /** Adapter-owned projection of the committed raw authority envelope. */
  taskCardProjector?: (record: TaskAuthorityRecordEnvelope) => TaskCard | { kind: "contract_gap"; message: string };
}

async function withAgentMutationAuthority<T>(
  teamName: string,
  options: AgentMutationBinding,
  action: (store: BeadsTaskStore) => Promise<T>,
): Promise<T> {
  if (!options.actingSessionFile) return action(await storeFor(teamName));
  const membershipId = options.actingMembershipId
    || (await assertCurrentSessionBinding(teamName, options.actor, options.actingSessionFile)).membershipId;
  if (!membershipId) throw new Error(`Current Membership for ${options.actor} on team ${teamName} has no membershipId.`);
  return withCurrentSessionBinding(teamName, options.actor, options.actingSessionFile, membershipId, async (config) => action(storeForConfig(config)));
}

export interface SemanticTaskUpdate {
  status?: TaskAuthorityRecord["status"];
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  design?: string;
  assignee?: string;
  claim?: boolean;
  appendNote?: string;
}

export interface SemanticTaskUpdateResult {
  task: TaskAuthorityRecord;
  taskCard?: TaskCard;
  before: TaskAuthorityRecord;
  appliedOperations: string[];
  deliveryDegraded: boolean;
  deliveryWarnings: string[];
}

export interface TaskMutationReceipt {
  task: TaskAuthorityRecord;
  taskCard?: TaskCard;
  /** True only when the requested authority mutation actually changed the graph. */
  changed: boolean;
  appliedOperations: string[];
  deliveryDegraded: boolean;
  deliveryWarnings: string[];
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

export interface TaskCreateReceipt extends TaskMutationReceipt {
  taskEnvelope?: TaskAuthorityRecordEnvelope;
  publication: TaskPublicationEvidence;
}

type TaskCoordinates = Pick<TaskCard, "id" | "title" | "status" | "assignee" | "version">;

function publicationInput(task: TaskAuthorityRecord): TaskCoordinates {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    version: taskVersionRef(task.version),
  };
}

function projectedCard(
  record: TaskAuthorityRecordEnvelope | undefined,
  options: InternalTaskPublicationOptions,
): TaskCard | undefined {
  if (!record || !options.taskCardProjector) return undefined;
  const card = options.taskCardProjector(record);
  if ("kind" in card) {
    const error = new Error(card.message);
    error.name = "upgrade_required";
    throw error;
  }
  return card;
}

function assigneeTransitionOperation(
  teamName: string,
  afterAssignee: string | undefined,
  taskCardProjector?: (record: TaskAuthorityRecordEnvelope) => TaskCard | { kind: "contract_gap"; message: string },
) {
  const operationId = `task_owner_transition_${crypto.randomUUID()}`;
  return {
    operationId,
    writeOption: {
      operationId,
      prepare: (beforeEnvelope: TaskAuthorityRecordEnvelope, previousOperationId?: string) => {
        const before = taskCardProjector?.(beforeEnvelope);
        if (!before || "kind" in before) {
          const error = new Error(
            before && "kind" in before
              ? before.message
              : `Task ${beforeEnvelope.task.id} has no canonical card for owner-transition preparation.`,
          );
          error.name = "upgrade_required";
          throw error;
        }
        return prepareOwnerTransitionIntent({
          operationId,
          teamName,
          before,
          afterOwner: afterAssignee || undefined,
          previousOperationId,
        });
      },
    },
  };
}

export async function applySemanticTaskUpdate(
  teamName: string,
  taskId: string,
  update: SemanticTaskUpdate,
  options: TaskWriteOptions & AgentMutationBinding & InternalTaskPublicationOptions,
): Promise<SemanticTaskUpdateResult> {
  return withSemanticTrace("task_update", { teamName, taskId }, async () => {
    const mutationFields = [update.title, update.description, update.acceptanceCriteria, update.design, update.status, update.assignee, update.appendNote]
      .filter((value) => value !== undefined);
    if (!update.claim && mutationFields.length === 0 && options.taskMetadata === undefined) {
      throw new Error("task_update requires a field, evidence, or claim=true.");
    }
    if (update.claim && mutationFields.length > 0) {
      throw new Error("claim is an atomic assignment operation and cannot be combined with other task_update changes.");
    }

    const desiredAssignee = update.claim ? options.actor : update.assignee;
    const assigneeTransition = desiredAssignee !== undefined
      ? assigneeTransitionOperation(teamName, desiredAssignee, options.taskCardProjector)
      : undefined;

    const mutation = await withAgentMutationAuthority(teamName, options, async (store) => {
      if (update.claim) {
        return store.claimWithResult(taskId, options.actor, {
          ...options,
          internalOwnerTransition: assigneeTransition?.writeOption,
        });
      }
      const fields: Partial<TaskAuthorityRecord> = {};
      if (update.title !== undefined) fields.title = update.title;
      if (update.description !== undefined) fields.description = update.description;
      if (update.acceptanceCriteria !== undefined) fields.acceptanceCriteria = update.acceptanceCriteria;
      if (update.design !== undefined) fields.design = update.design;
      if (update.status !== undefined) fields.status = update.status;
      if (update.assignee !== undefined) fields.assignee = update.assignee;
      return store.updateWithResult(taskId, fields, {
        ...options,
        appendNote: update.appendNote,
        internalOwnerTransition: assigneeTransition?.writeOption,
      });
    });

    const firstBefore = mutation.before;
    const current = mutation.after;
    const postStateCard = projectedCard(mutation.afterEnvelope, options);
    const appliedOperations = mutation.appliedOperations;
    if (
      options.actingSessionFile
      && (firstBefore.assignee === options.actor || current.assignee === options.actor)
    ) {
      await suppressTaskVersionForSession(teamName, options.actor, options.actingSessionFile, postStateCard ?? publicationInput(current));
    }
    const assigneeChanged = firstBefore.assignee !== current.assignee;
    const publication = appliedOperations.length === 0
      ? undefined
      : await publishTaskMutation(
        teamName,
        firstBefore,
        current,
        changeKindForUpdate(update),
        options.actor,
        options.taskEventEvidence,
        { deliver: !assigneeChanged, taskMetadata: options.taskMetadata, taskCard: postStateCard },
      );
    if (assigneeChanged && assigneeTransition && !postStateCard) {
      const error = new Error(`Task ${current.id} has no canonical post-state card for owner-transition delivery.`);
      error.name = "upgrade_required";
      throw error;
    }
    const deliveryWarnings = appliedOperations.length === 0
      ? []
      : assigneeChanged && assigneeTransition && postStateCard
        ? [...publication!.warnings, ...await completeOwnerTransitionIntent(teamName, assigneeTransition.operationId, postStateCard, {})]
        : publication!.warnings;
    return {
      task: current,
      ...(postStateCard ? { taskCard: postStateCard } : {}),
      before: firstBefore,
      appliedOperations,
      deliveryDegraded: deliveryWarnings.length > 0,
      deliveryWarnings,
    };
  });
}

export async function createTask(
  teamName: string,
  input: CreateTaskInput,
  binding?: AgentMutationBinding,
  internalPublication: InternalTaskPublicationOptions = {},
): Promise<TaskCreateReceipt> {
  return withSemanticTrace("task_create", { teamName }, async () => {
    const mutate = (store: BeadsTaskStore) => store.createWithResult(input, {
      idempotencyKey: input.idempotencyKey,
      actor: binding?.actor,
    });
    const result = binding
      ? await withAgentMutationAuthority(teamName, binding, mutate)
      : await mutate(await storeFor(teamName));
    if (result.replayed) {
      const replayCard = projectedCard(result.taskEnvelope, internalPublication);
      return {
        ...(replayCard ? { taskCard: replayCard } : {}),
        task: result.task,
        changed: false,
        appliedOperations: [],
        deliveryDegraded: false,
        deliveryWarnings: [],
        publication: {
          teamEvent: { appended: false },
          delivery: {
            attemptedRecipients: [],
            failedRecipients: [],
            recoveryRecordedFor: [],
            recoveryRecordFailedFor: [],
          },
        },
      };
    }
    const postStateCard = projectedCard(result.taskEnvelope, internalPublication);
    if (binding?.actingSessionFile && result.task.assignee === binding.actor) {
      await suppressTaskVersionForSession(teamName, binding.actor, binding.actingSessionFile!, result.taskEnvelope && postStateCard ? postStateCard : publicationInput(result.task));
    }
    const publication = await publishTaskMutation(
      teamName,
      result.task,
      result.task,
      result.task.assignee ? "assigned" : "task_changed",
      binding?.actor,
      internalPublication.taskEventEvidence,
      { taskMetadata: internalPublication.taskMetadata, taskCard: postStateCard },
    );
    return {
      task: result.task,
      ...(postStateCard ? { taskCard: postStateCard } : {}),
      changed: true,
      appliedOperations: ["create"],
      deliveryDegraded: publication.warnings.length > 0,
      deliveryWarnings: publication.warnings,
      publication: publication.evidence,
    };
  });
}

export async function readTaskAuthorityRecordEnvelope(
  teamName: string,
  taskId: string,
): Promise<TaskAuthorityRecordEnvelope> {
  return withSemanticTrace("task_read",  { teamName, taskId }, async () =>
    (await storeFor(teamName)).readTaskAuthorityRecordEnvelope(taskId));
}

/** Read canonical Task metadata for exact Task IDs with one authority query. */
export async function readTaskAuthorityRecordEnvelopes(
  teamName: string,
  taskIds: readonly string[],
): Promise<Array<TaskAuthorityRecordEnvelope | undefined>> {
  return withSemanticTrace("task_read_many",  { teamName }, async () =>
    (await storeFor(teamName)).readTaskAuthorityRecordEnvelopes(taskIds));
}

/** Select Task IDs from the compact Team-scoped list surface. */
export async function listTaskIds(teamName: string): Promise<string[]> {
  return withSemanticTrace("task_list",  { teamName }, async () =>
    (await storeFor(teamName)).list()).then((listed) => listed.map((task) => task.id));
}

export async function mutateTaskLink(
  teamName: string,
  taskId: string,
  link: BeadsTaskLink,
  options: TaskWriteOptions & AgentMutationBinding,
): Promise<TaskMutationReceipt> {
  return withSemanticTrace("task_link", { teamName, taskId }, async () => {
    const mutation = await withAgentMutationAuthority(teamName, options, (store) =>
      store.mutateLinkWithResult(taskId, link, options));
    const postStateCard = projectedCard(mutation.afterEnvelope, options);
    if (options.actingSessionFile && mutation.after.assignee === options.actor) {
      await suppressTaskVersionForSession(teamName, options.actor, options.actingSessionFile, postStateCard ?? publicationInput(mutation.after));
    }
    const deliveryWarnings = mutation.appliedOperations.length === 0
      ? []
      : (await publishTaskMutation(
        teamName,
        mutation.before,
        mutation.after,
        "relation_changed",
        options.actor,
        [{
          kind: "relation",
          text: `Task relation ${link.action} ${link.relation} ${link.targetId}.`,
        }],
        { taskCard: postStateCard },
      )).warnings;
    return {
      task: mutation.after,
      ...(postStateCard ? { taskCard: postStateCard } : {}),
      changed: mutation.appliedOperations.length > 0,
      appliedOperations: mutation.appliedOperations,
      deliveryDegraded: deliveryWarnings.length > 0,
      deliveryWarnings,
    };
  });
}

function changeKindForUpdate(updates: SemanticTaskUpdate): TaskChangeKind {
  if (updates.assignee !== undefined || updates.claim) return "assigned";
  if (updates.status !== undefined) return "status_changed";
  if (updates.appendNote !== undefined) return "note_appended";
  return "task_changed";
}

function defaultTaskEventEvidence(
  before: TaskAuthorityRecord,
  after: TaskAuthorityRecord,
  kind: TaskChangeKind,
): TaskEventEvidenceInput {
  if (before === after) return { kind: "created", text: "Task created." };
  if (kind === "assigned" || kind === "ownership_lost") {
    return { kind: "assignment", text: `Task assignee changed to ${after.assignee ?? "unassigned"}.` };
  }
  if (kind === "status_changed") return { kind: "status", text: `Task status changed to ${after.status}.` };
  if (kind === "relation_changed") return { kind: "relation", text: "Task relation changed." };
  if (kind === "note_appended") return { kind: "note", text: "Task note changed." };
  return { kind: "goal", text: "Task contract changed." };
}

async function publishTaskMutation(
  teamName: string,
  before: TaskAuthorityRecord,
  after: TaskAuthorityRecord,
  kind: TaskChangeKind,
  actor?: string,
  taskEventEvidence: readonly TaskEventEvidenceInput[] = [],
  options: {
    deliver?: boolean;
    taskMetadata?: Pick<TaskMetadata, "goal" | "current_context">;
    /** Exact canonical post-state card supplied by the adapter caller. */
    taskCard?: TaskCard;
  } = {},
): Promise<{ warnings: string[]; evidence: TaskPublicationEvidence }> {
  const targets: Array<{ recipient: string; kind: TaskChangeKind }> = [];
  if (before.assignee && before.assignee !== after.assignee) {
    targets.push({ recipient: before.assignee, kind: "ownership_lost" });
  }
  if (after.assignee) targets.push({ recipient: after.assignee, kind });
  const unique = [...new Map(targets.map((target) => [`${target.recipient}:${target.kind}`, target])).values()];
  const warnings: string[] = [];
  let teamEventAppended = false;
  const failedRecipients: string[] = [];
  const recoveryRecordedFor: string[] = [];
  const recoveryRecordFailedFor: string[] = [];
  const publicationVersion: import("../model-tool-contract/task-version-ref").TaskVersionRef = options.taskCard
    ? options.taskCard.version as import("../model-tool-contract/task-version-ref").TaskVersionRef
    : taskVersionRef(after.version);
  try {
    const change: TaskEventChange = kind === "assigned" || kind === "ownership_lost" ? "assigned"
      : kind === "status_changed" ? "status"
      : kind === "note_appended" ? "note"
      : kind === "relation_changed" ? "relation"
      : "goal";
    const baseEvent = {
      type: "task" as const,
      ref: { taskId: after.id, version: publicationVersion },
      change,
      actor: actor ?? "external",
    };
    const evidenceEntries = taskEventEvidence.length > 0
      ? taskEventEvidence
      : [defaultTaskEventEvidence(before, after, kind)];
    for (const [index, evidence] of evidenceEntries.entries()) {
      await appendTaskEvidenceEvent(teamName, {
        ...baseEvent,
        change: index === 0 ? change : "note",
        taskEvidence: evidence,
      });
    }
    teamEventAppended = true;
  } catch (error) {
    warnings.push(`Task ${after.id} committed but its Team event was not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
  const deliveryTargets = options.deliver === false ? [] : unique;
  for (const target of deliveryTargets) {
    try {
      const card = options.taskCard;
      if (!card) throw new Error(`Task ${after.id} has no canonical post-state card for delivery publication.`);
      await enqueueTaskChangeForRecipient(teamName, card, target.recipient, target.kind);
    } catch (error) {
      const warning = `Task ${after.id} committed but delivery enqueue for ${target.recipient} failed`;
      warnings.push(warning);
      failedRecipients.push(target.recipient);
      try {
        if (!options.taskCard) throw new Error(`Task ${after.id} has no canonical card for delivery recovery.`);
        await recordTaskDeliveryRecovery({
          teamName,
          taskId: after.id,
          taskVersion: publicationVersion,
          recipients: [target.recipient],
          changeKind: target.kind,
          recordedAt: new Date().toISOString(),
          reason: "enqueue-failed",
          taskProjection: options.taskCard,
        });
        recoveryRecordedFor.push(target.recipient);
      } catch {
        warnings.push(`${warning}; recovery evidence could not be persisted`);
        recoveryRecordFailedFor.push(target.recipient);
      }
      console.warn(`[pi-teams] ${warning}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    warnings,
    evidence: {
      teamEvent: { appended: teamEventAppended },
      delivery: {
        attemptedRecipients: [...new Set(deliveryTargets.map((target) => target.recipient))],
        failedRecipients: [...new Set(failedRecipients)],
        recoveryRecordedFor: [...new Set(recoveryRecordedFor)],
        recoveryRecordFailedFor: [...new Set(recoveryRecordFailedFor)],
      },
    },
  };
}

export function createBeadsStore(options: BeadsTaskStoreOptions): BeadsTaskStore {
  return new BeadsTaskStore(options);
}
