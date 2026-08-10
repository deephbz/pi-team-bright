// Project: pi-teams
import path from "node:path";
import crypto from "node:crypto";
import type { BeadsAuthorityFingerprint, TeamConfig } from "../team-authority/contracts";
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
import { withSemanticTrace } from "../utils/trace";
import { taskVersionRef, type TaskVersionRef } from "../task-authority/task-version-ref";
import type { TaskCard } from "../task-authority/task-domain";

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

export type TaskMutationCoordinates = Pick<TaskCard, "id" | "title" | "status" | "assignee"> & { version: TaskVersionRef };

export interface TaskMutationPublicationInput {
  teamName: string;
  before: TaskMutationCoordinates;
  after: TaskMutationCoordinates;
  created: boolean;
  kind: TaskMutationChangeKind;
  actor?: string;
  taskEventEvidence: readonly TaskMutationEventEvidenceInput[];
  deliver: boolean;
  taskCard?: TaskCard;
}

export interface TaskOwnerTransitionPreparationInput {
  operationId: string;
  teamName: string;
  before: TaskCard;
  afterOwner?: string;
  previousOperationId?: string;
}

export interface TaskMutationSuppressionInput {
  teamName: string;
  recipient: string;
  sessionFile: string;
  task: TaskCard | TaskMutationCoordinates;
}

export interface TaskOwnerTransitionCompletionInput {
  teamName: string;
  operationId: string;
  task: TaskCard;
}

export interface TaskMutationPublicationPort {
  prepareOwnerTransitionIntent(input: TaskOwnerTransitionPreparationInput): Promise<boolean>;
  suppressTaskVersionForSession(input: TaskMutationSuppressionInput): Promise<void>;
  publishTaskMutation(input: TaskMutationPublicationInput): Promise<{ warnings: string[]; evidence: TaskPublicationEvidence }>;
  completeOwnerTransitionIntent(input: TaskOwnerTransitionCompletionInput): Promise<string[]>;
}

export interface InternalTaskPublicationOptions {
  /** Structured evidence for internal Task writes. */
  taskEventEvidence?: readonly TaskMutationEventEvidenceInput[];
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

function publicationInput(task: TaskAuthorityRecord): TaskMutationCoordinates {
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
  publicationPort: TaskMutationPublicationPort,
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
        return publicationPort.prepareOwnerTransitionIntent({
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
  publicationPort: TaskMutationPublicationPort,
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
      ? assigneeTransitionOperation(teamName, desiredAssignee, publicationPort, options.taskCardProjector)
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
      await publicationPort.suppressTaskVersionForSession({
        teamName,
        recipient: options.actor,
        sessionFile: options.actingSessionFile,
        task: postStateCard ?? publicationInput(current),
      });
    }
    const assigneeChanged = firstBefore.assignee !== current.assignee;
    const publication = appliedOperations.length === 0
      ? undefined
      : await publicationPort.publishTaskMutation({
        teamName,
        before: publicationInput(firstBefore),
        after: publicationInput(current),
        created: false,
        kind: changeKindForUpdate(update),
        actor: options.actor,
        taskEventEvidence: options.taskEventEvidence ?? [],
        deliver: !assigneeChanged,
        ...(postStateCard ? { taskCard: postStateCard } : {}),
      });
    if (assigneeChanged && assigneeTransition && !postStateCard) {
      const error = new Error(`Task ${current.id} has no canonical post-state card for owner-transition delivery.`);
      error.name = "upgrade_required";
      throw error;
    }
    const deliveryWarnings = appliedOperations.length === 0
      ? []
      : assigneeChanged && assigneeTransition && postStateCard
        ? [...publication!.warnings, ...await publicationPort.completeOwnerTransitionIntent({ teamName, operationId: assigneeTransition.operationId, task: postStateCard })]
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
  publicationPort: TaskMutationPublicationPort,
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
      await publicationPort.suppressTaskVersionForSession({
        teamName,
        recipient: binding.actor,
        sessionFile: binding.actingSessionFile!,
        task: result.taskEnvelope && postStateCard ? postStateCard : publicationInput(result.task),
      });
    }
    const publication = await publicationPort.publishTaskMutation({
      teamName,
      before: publicationInput(result.task),
      after: publicationInput(result.task),
      created: true,
      kind: result.task.assignee ? "assigned" : "task_changed",
      actor: binding?.actor,
      taskEventEvidence: internalPublication.taskEventEvidence ?? [],
      deliver: true,
      ...(postStateCard ? { taskCard: postStateCard } : {}),
    });
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
  publicationPort: TaskMutationPublicationPort,
): Promise<TaskMutationReceipt> {
  return withSemanticTrace("task_link", { teamName, taskId }, async () => {
    const mutation = await withAgentMutationAuthority(teamName, options, (store) =>
      store.mutateLinkWithResult(taskId, link, options));
    const postStateCard = projectedCard(mutation.afterEnvelope, options);
    if (options.actingSessionFile && mutation.after.assignee === options.actor) {
      await publicationPort.suppressTaskVersionForSession({
        teamName,
        recipient: options.actor,
        sessionFile: options.actingSessionFile,
        task: postStateCard ?? publicationInput(mutation.after),
      });
    }
    const deliveryWarnings = mutation.appliedOperations.length === 0
      ? []
      : (await publicationPort.publishTaskMutation({
        teamName,
        before: publicationInput(mutation.before),
        after: publicationInput(mutation.after),
        created: false,
        kind: "relation_changed",
        actor: options.actor,
        taskEventEvidence: [{
          kind: "relation",
          text: `Task relation ${link.action} ${link.relation} ${link.targetId}.`,
        }],
        deliver: true,
        ...(postStateCard ? { taskCard: postStateCard } : {}),
      })).warnings;
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

function changeKindForUpdate(updates: SemanticTaskUpdate): TaskMutationChangeKind {
  if (updates.assignee !== undefined || updates.claim) return "assigned";
  if (updates.status !== undefined) return "status_changed";
  if (updates.appendNote !== undefined) return "note_appended";
  return "task_changed";
}

export function createBeadsStore(options: BeadsTaskStoreOptions): BeadsTaskStore {
  return new BeadsTaskStore(options);
}
