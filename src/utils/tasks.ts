// Project: pi-teams
import path from "node:path";
import crypto from "node:crypto";
import { BeadsAuthorityFingerprint, TaskFile, TaskListItem, TeamConfig } from "./models";
import {
  teamExists,
  readConfig,
  assertCurrentSessionBinding,
  withCurrentSessionBinding,
  assertNoOrphanedBeadsCutover,
} from "./teams";
import {
  BeadsTaskStore,
  CreateTaskInput,
  TaskWriteOptions,
  BeadsTaskStoreOptions,
  BeadsTaskLink,
  TaskMutationResult,
  assertBeadsWorkspaceRoot,
  initializeBeadsWorkspace,
  readBeadsAuthorityFingerprint,
} from "./beads";
import { teamDir } from "./paths";
import {
  completeOwnerTransitionIntent,
  enqueueTaskChangeForRecipient,
  prepareOwnerTransitionIntent,
  recordTaskDeliveryRecovery,
  suppressTaskVersionForSession,
  TaskChangeKind,
} from "./task-delivery";
import { withSemanticTrace } from "./trace";

export const BEADS_WORKSPACE_ENV = "PI_TEAMS_BEADS_WORKSPACE";

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
  status?: TaskFile["status"];
  title?: string;
  description?: string;
  design?: string;
  assignee?: string;
  claim?: boolean;
  appendNote?: string;
}

export interface SemanticTaskUpdateResult {
  task: TaskFile;
  before: TaskFile;
  appliedOperations: string[];
  deliveryDegraded: boolean;
  deliveryWarnings: string[];
}

export interface TaskMutationReceipt {
  task: TaskFile;
  appliedOperations: string[];
  deliveryDegraded: boolean;
  deliveryWarnings: string[];
}

function assigneeTransitionOperation(teamName: string, afterAssignee: string | undefined) {
  const operationId = `task_owner_transition_${crypto.randomUUID()}`;
  return {
    operationId,
    writeOption: {
      operationId,
      prepare: (before: TaskFile, previousOperationId?: string) => prepareOwnerTransitionIntent({
        operationId,
        teamName,
        before,
        afterOwner: afterAssignee || undefined,
        previousOperationId,
      }),
    },
  };
}

export async function applySemanticTaskUpdate(
  teamName: string,
  taskId: string,
  update: SemanticTaskUpdate,
  options: TaskWriteOptions & AgentMutationBinding,
): Promise<SemanticTaskUpdateResult> {
  return withSemanticTrace("task_update", { teamName, taskId }, async () => {
    const mutationFields = [update.title, update.description, update.design, update.status, update.assignee, update.appendNote]
      .filter((value) => value !== undefined);
    if (!update.claim && mutationFields.length === 0) {
      throw new Error("task_update requires at least one field, append_note, or claim=true.");
    }
    if (update.claim && mutationFields.length > 0) {
      throw new Error("claim is an atomic assignment operation and cannot be combined with other task_update changes.");
    }

    const desiredAssignee = update.claim ? options.actor : update.assignee;
    const assigneeTransition = desiredAssignee !== undefined
      ? assigneeTransitionOperation(teamName, desiredAssignee)
      : undefined;

    const mutation = await withAgentMutationAuthority(teamName, options, async (store) => {
      if (update.claim) {
        return store.claimWithResult(taskId, options.actor, {
          ...options,
          internalOwnerTransition: assigneeTransition?.writeOption,
        });
      }
      const fields: Partial<TaskFile> = {};
      if (update.title !== undefined) fields.title = update.title;
      if (update.description !== undefined) fields.description = update.description;
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
    const appliedOperations = mutation.appliedOperations;
    if (
      options.actingSessionFile
      && (firstBefore.assignee === options.actor || current.assignee === options.actor)
    ) {
      await suppressTaskVersionForSession(teamName, options.actor, options.actingSessionFile, current);
    }
    const assigneeChanged = firstBefore.assignee !== current.assignee;
    const deliveryWarnings = appliedOperations.length === 0
      ? []
      : assigneeChanged && assigneeTransition
        ? await completeOwnerTransitionIntent(teamName, assigneeTransition.operationId, current)
        : await publishTaskMutation(teamName, firstBefore, current, changeKindForUpdate(update), options.actor);
    return {
      task: current,
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
): Promise<TaskFile> {
  return withSemanticTrace("task_create", { teamName }, async () => {
    const mutate = (store: BeadsTaskStore) => store.create(input, {
      idempotencyKey: input.idempotencyKey,
      actor: binding?.actor,
    });
    const task = binding
      ? await withAgentMutationAuthority(teamName, binding, mutate)
      : await mutate(await storeFor(teamName));
    if (binding?.actingSessionFile && task.assignee === binding.actor) {
      await suppressTaskVersionForSession(teamName, binding.actor, binding.actingSessionFile, task);
    }
    if (task.assignee) await publishTaskMutation(teamName, task, task, "assigned", binding?.actor);
    return task;
  });
}

export async function readTask(teamName: string, taskId: string): Promise<TaskFile> {
  return withSemanticTrace("task_read", { teamName, taskId }, async () => (await storeFor(teamName)).read(taskId));
}

export async function listTasks(teamName: string): Promise<TaskListItem[]> {
  return withSemanticTrace("task_list", { teamName }, async () => {
    const tasks = await (await storeFor(teamName)).list();
    return tasks.map(({ version: _projectionRevision, ...task }) => task);
  });
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
    if (options.actingSessionFile && mutation.after.assignee === options.actor) {
      await suppressTaskVersionForSession(teamName, options.actor, options.actingSessionFile, mutation.after);
    }
    const deliveryWarnings = mutation.appliedOperations.length === 0
      ? []
      : await publishTaskMutation(teamName, mutation.before, mutation.after, "relation_changed", options.actor);
    return {
      task: mutation.after,
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

async function publishTaskMutation(
  teamName: string,
  before: TaskFile,
  after: TaskFile,
  kind: TaskChangeKind,
  actor?: string,
): Promise<string[]> {
  const targets: Array<{ recipient: string; kind: TaskChangeKind }> = [];
  if (before.assignee && before.assignee !== after.assignee) {
    targets.push({ recipient: before.assignee, kind: "ownership_lost" });
  }
  if (after.assignee) targets.push({ recipient: after.assignee, kind });
  const unique = [...new Map(targets.map((target) => [`${target.recipient}:${target.kind}`, target])).values()];
  const warnings: string[] = [];
  for (const target of unique) {
    try {
      await enqueueTaskChangeForRecipient(teamName, after, target.recipient, target.kind);
    } catch (error) {
      const warning = `Task ${after.id} committed but delivery enqueue for ${target.recipient} failed`;
      warnings.push(warning);
      try {
        await recordTaskDeliveryRecovery({
          teamName,
          taskId: after.id,
          taskVersion: after.version,
          recipients: [target.recipient],
          changeKind: target.kind,
          recordedAt: new Date().toISOString(),
          reason: "enqueue-failed",
          taskSnapshot: structuredClone(after),
        });
      } catch {
        warnings.push(`${warning}; recovery evidence could not be persisted`);
      }
      console.warn(`[pi-teams] ${warning}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return warnings;
}

export function createBeadsStore(options: BeadsTaskStoreOptions): BeadsTaskStore {
  return new BeadsTaskStore(options);
}
