// Project: pi-teams
import path from "node:path";
import crypto from "node:crypto";
import { BeadsAuthorityFingerprint, TaskFile, TeamConfig } from "./models";
import { teamExists, readConfig, assertCurrentSessionBinding, withCurrentSessionBinding } from "./teams";
import {
  BeadsTaskStore,
  CreateTaskInput,
  TaskWriteOptions,
  BeadsTaskStoreOptions,
  BeadsProgressEntry,
  TaskMutationResult,
  assertBeadsWorkspaceRoot,
  readBeadsAuthorityFingerprint,
} from "./beads";
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

export function configuredBeadsWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  const workspace = env[BEADS_WORKSPACE_ENV]?.trim();
  if (!workspace) {
    throw new Error(`No default Beads workspace is configured. Set ${BEADS_WORKSPACE_ENV} to an absolute initialized Beads workspace.`);
  }
  if (!path.isAbsolute(workspace)) throw new Error(`${BEADS_WORKSPACE_ENV} must be an absolute path: ${workspace}`);
  return workspace;
}

/** Resolve one operator-owned Task authority for team creation/reconnect. */
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
  const workspace = configuredBeadsWorkspace();
  assertBeadsWorkspaceRoot(workspace);
  const fingerprint = readBeadsAuthorityFingerprint(workspace);
  const store = new BeadsTaskStore({ teamName, workspace, authorityFingerprint: fingerprint, requireExpectedVersion: true });
  await store.assertWorkspaceRoot();
  await store.list();
  return { workspace, authorityId: `task_authority_${crypto.randomUUID()}`, fingerprint };
}

export interface TaskStore {
  create(input: CreateTaskInput, options?: TaskWriteOptions): Promise<TaskFile>;
  update(taskId: string, updates: Partial<TaskFile>, options?: TaskWriteOptions): Promise<TaskFile>;
  submitPlan(taskId: string, plan: string, options?: TaskWriteOptions): Promise<TaskFile>;
  evaluatePlan(taskId: string, action: "approve" | "reject", feedback?: string, options?: TaskWriteOptions): Promise<TaskFile>;
  read(taskId: string): Promise<TaskFile>;
  list(): Promise<TaskFile[]>;
  claim?(taskId: string, actor?: string, options?: TaskWriteOptions): Promise<TaskFile>;
  addDependency?(taskId: string, blockerId: string, options?: TaskWriteOptions): Promise<TaskFile>;
  addProgress?(taskId: string, entry: BeadsProgressEntry, options?: TaskWriteOptions): Promise<TaskFile>;
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
  owner?: string;
  claim?: boolean;
  blockedBy?: string[];
  blocks?: string[];
  progress?: string;
  pendingProblem?: string;
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

function ownerTransitionOperation(teamName: string, afterOwner: string | undefined) {
  const operationId = `task_owner_transition_${crypto.randomUUID()}`;
  return {
    operationId,
    writeOption: {
      operationId,
      prepare: (before: TaskFile, previousOperationId?: string) => prepareOwnerTransitionIntent({
        operationId,
        teamName,
        before,
        afterOwner: afterOwner || undefined,
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
    const desiredOwner = update.claim ? options.actor : update.owner;
    const ownerTransition = desiredOwner !== undefined
      ? ownerTransitionOperation(teamName, desiredOwner)
      : undefined;
    const terminal = update.status === "completed" || update.status === "deleted";
    const nonterminalOperations = update.owner !== undefined
      || update.claim
      || (update.blockedBy?.length ?? 0) > 0
      || (update.blocks?.length ?? 0) > 0
      || !!update.progress
      || !!update.pendingProblem;
    if (terminal && nonterminalOperations) {
      throw new Error("A terminal status transition cannot be combined with owner, claim, dependency, progress, or pending-problem changes.");
    }
    if (update.claim && (update.owner !== undefined || update.status !== undefined || (update.blockedBy?.length ?? 0) > 0 || !!update.progress || !!update.pendingProblem)) {
      throw new Error("claim is an atomic ownership operation and cannot be combined with other task_update mutations.");
    }
    if ((update.blocks?.length ?? 0) > 0) {
      throw new Error("task_update.blocks mutates another Task without its version; use blocked_by on the target Task.");
    }
    const fieldClass = update.status !== undefined || update.owner !== undefined;
    const dependencyCount = update.blockedBy?.length ?? 0;
    const progressClass = !!update.progress;
    const problemClass = !!update.pendingProblem;
    const semanticClasses = Number(fieldClass) + Number(dependencyCount > 0) + Number(progressClass) + Number(problemClass);
    if (semanticClasses > 1) {
      throw new Error("task_update cannot hide partial multi-command success: combine only owner with a nonterminal status; dependency, progress, and pending_problem are separate semantic operations.");
    }
    if (dependencyCount > 1) {
      throw new Error("Multiple dependency links require a transactional Beads batch and are not yet supported in one task_update.");
    }
    const mutation = await withAgentMutationAuthority(teamName, options, async (store) => {
      let firstBefore: TaskFile | undefined;
      let current: TaskFile | undefined;
      const appliedOperations: string[] = [];
      let expectedVersion = options.expectedVersion;
      const absorb = (result: TaskMutationResult) => {
        firstBefore ||= result.before;
        current = result.after;
        appliedOperations.push(...result.appliedOperations);
        expectedVersion = result.after.version;
      };

      if (update.claim) {
        absorb(await store.claimWithResult(taskId, options.actor, {
          ...options,
          expectedVersion,
          internalOwnerTransition: ownerTransition?.writeOption,
        }));
      } else {
        const fields: Partial<TaskFile> = {};
        if (update.status !== undefined) fields.status = update.status;
        if (update.owner !== undefined) fields.owner = update.owner;
        if (Object.keys(fields).length > 0) absorb(await store.updateWithResult(taskId, fields, {
          ...options,
          expectedVersion,
          internalOwnerTransition: ownerTransition?.writeOption,
        }));
        for (const blockerId of update.blockedBy || []) absorb(await store.addDependencyWithResult(taskId, blockerId, { ...options, expectedVersion }));
        if (update.progress) absorb(await store.addProgressWithResult(taskId, { kind: "progress", text: update.progress, actor: options.actor }, { ...options, expectedVersion }));
        if (update.pendingProblem) absorb(await store.addProgressWithResult(taskId, { kind: "pending-problem", text: update.pendingProblem, actor: options.actor }, { ...options, expectedVersion }));
      }
      if (!current) current = await store.read(taskId);
      firstBefore ||= current;
      return { firstBefore, current, appliedOperations };
    });
    const { firstBefore, current, appliedOperations } = mutation;
    if (
      options.actingSessionFile
      && (firstBefore.owner === options.actor || current.owner === options.actor)
    ) {
      await suppressTaskVersionForSession(teamName, options.actor, options.actingSessionFile, current);
    }
    const ownerChanged = firstBefore.owner !== current.owner;
    const deliveryWarnings = appliedOperations.length === 0
      ? []
      : ownerChanged && ownerTransition
        ? await completeOwnerTransitionIntent(teamName, ownerTransition.operationId, current)
        : await publishTaskMutation(teamName, firstBefore, current, changeKindForUpdate({ status: update.status, owner: update.owner }), options.actor);
    return {
      task: current,
      before: firstBefore,
      appliedOperations,
      deliveryDegraded: deliveryWarnings.length > 0,
      deliveryWarnings,
    };
  });
}

export async function createTask(teamName: string, subject: string, description: string, activeForm = "", metadata?: Record<string, any>, binding?: AgentMutationBinding): Promise<TaskFile> {
  return withSemanticTrace("task_create", { teamName }, async () => {
    const idempotencyKey = typeof metadata?.pi_teams_idempotency_key === "string" ? metadata.pi_teams_idempotency_key : undefined;
    const mutate = (store: BeadsTaskStore) => store.create({ subject, description, activeForm, metadata, idempotencyKey }, { idempotencyKey, actor: binding?.actor });
    return binding ? withAgentMutationAuthority(teamName, binding, mutate) : mutate(await storeFor(teamName));
  });
}

export async function updateTask(teamName: string, taskId: string, updates: Partial<TaskFile>, options: TaskWriteOptions = {}): Promise<TaskFile> {
  const store = await storeFor(teamName);
  const transition = updates.owner !== undefined ? ownerTransitionOperation(teamName, updates.owner) : undefined;
  const mutation = await store.updateWithResult(taskId, updates, {
    ...options,
    internalOwnerTransition: transition?.writeOption,
  });
  if (mutation.before.owner !== mutation.after.owner && transition) {
    await completeOwnerTransitionIntent(teamName, transition.operationId, mutation.after);
  } else {
    await publishTaskMutation(teamName, mutation.before, mutation.after, changeKindForUpdate(updates), options.actor);
  }
  return mutation.after;
}

export async function submitPlan(teamName: string, taskId: string, plan: string, options?: TaskWriteOptions): Promise<TaskFile> {
  return (await submitPlanWithReceipt(teamName, taskId, plan, options)).task;
}

export async function submitPlanWithReceipt(teamName: string, taskId: string, plan: string, options?: TaskWriteOptions & Partial<AgentMutationBinding>): Promise<TaskMutationReceipt> {
  return withSemanticTrace("task_submit_plan", { teamName, taskId }, async () => {
    const mutate = (store: BeadsTaskStore) => store.submitPlan(taskId, plan, options);
    const updated = options?.actor ? await withAgentMutationAuthority(teamName, options as TaskWriteOptions & AgentMutationBinding, mutate) : await mutate(await storeFor(teamName));
    const deliveryWarnings = await publishTaskChange(teamName, updated, "plan_changed", options?.actor);
    return {
      task: updated,
      appliedOperations: ["submit_plan"],
      deliveryDegraded: deliveryWarnings.length > 0,
      deliveryWarnings,
    };
  });
}

export async function evaluatePlan(teamName: string, taskId: string, action: "approve" | "reject", feedback?: string, options?: TaskWriteOptions): Promise<TaskFile> {
  return (await evaluatePlanWithReceipt(teamName, taskId, action, feedback, options)).task;
}

export async function evaluatePlanWithReceipt(teamName: string, taskId: string, action: "approve" | "reject", feedback?: string, options?: TaskWriteOptions & Partial<AgentMutationBinding>): Promise<TaskMutationReceipt> {
  return withSemanticTrace("task_evaluate_plan", { teamName, taskId }, async () => {
    const mutate = (store: BeadsTaskStore) => store.evaluatePlan(taskId, action, feedback, options);
    const updated = options?.actor ? await withAgentMutationAuthority(teamName, options as TaskWriteOptions & AgentMutationBinding, mutate) : await mutate(await storeFor(teamName));
    const deliveryWarnings = await publishTaskChange(teamName, updated, "plan_changed", options?.actor);
    return {
      task: updated,
      appliedOperations: [`${action}_plan`],
      deliveryDegraded: deliveryWarnings.length > 0,
      deliveryWarnings,
    };
  });
}

export async function readTask(teamName: string, taskId: string): Promise<TaskFile> {
  return withSemanticTrace("task_read", { teamName, taskId }, async () => (await storeFor(teamName)).read(taskId));
}

export async function listTasks(teamName: string): Promise<TaskFile[]> {
  return withSemanticTrace("task_list", { teamName }, async () => {
    const tasks = await (await storeFor(teamName)).list();
    return tasks.map(({ version: _projectionRevision, ...task }) => task);
  });
}

export async function claimTask(teamName: string, taskId: string, actor: string, options?: TaskWriteOptions): Promise<TaskFile> {
  const store = await storeFor(teamName);
  const transition = ownerTransitionOperation(teamName, actor);
  const mutation = await store.claimWithResult(taskId, actor, {
    ...options,
    internalOwnerTransition: transition.writeOption,
  });
  if (mutation.before.owner !== mutation.after.owner) {
    await completeOwnerTransitionIntent(teamName, transition.operationId, mutation.after);
  } else {
    await publishTaskMutation(teamName, mutation.before, mutation.after, "assigned", actor);
  }
  return mutation.after;
}

export async function addTaskDependency(teamName: string, taskId: string, blockerId: string, options?: TaskWriteOptions): Promise<TaskFile> {
  const store = await storeFor(teamName);
  if (!store.addDependency) throw new Error(`Task backend for team ${teamName} does not support dependencies.`);
  const updated = await store.addDependency(taskId, blockerId, options);
  await publishTaskChange(teamName, updated, "dependency_changed", options?.actor);
  return updated;
}

export async function addTaskProgress(teamName: string, taskId: string, entry: BeadsProgressEntry, options?: TaskWriteOptions): Promise<TaskFile> {
  const store = await storeFor(teamName);
  if (!store.addProgress) throw new Error(`Task backend for team ${teamName} does not support progress entries.`);
  const updated = await store.addProgress(taskId, entry, options);
  await publishTaskChange(teamName, updated, "progress_changed", options?.actor);
  return updated;
}

function changeKindForUpdate(updates: Partial<TaskFile>): TaskChangeKind {
  if (updates.owner !== undefined) return "assigned";
  if (updates.status !== undefined) return "status_changed";
  if (updates.plan !== undefined || updates.planFeedback !== undefined) return "plan_changed";
  if (updates.blockedBy !== undefined || updates.blocks !== undefined) return "dependency_changed";
  return "task_changed";
}

async function publishTaskChange(teamName: string, task: TaskFile, kind: TaskChangeKind, actor?: string): Promise<string[]> {
  // Reuse the mutation publisher so post-commit delivery degradation is both
  // recoverable and visible to the caller without making delivery transactional.
  return publishTaskMutation(teamName, task, task, kind, actor);
}

async function publishTaskMutation(
  teamName: string,
  before: TaskFile,
  after: TaskFile,
  kind: TaskChangeKind,
  actor?: string,
): Promise<string[]> {
  const targets: Array<{ recipient: string; kind: TaskChangeKind }> = [];
  if (before.owner && before.owner !== after.owner) {
    targets.push({ recipient: before.owner, kind: "ownership_lost" });
  }
  if (after.owner) targets.push({ recipient: after.owner, kind });
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
          taskVersion: after.version || "unknown",
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
