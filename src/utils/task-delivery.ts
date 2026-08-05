import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TeamConfig } from "./models";
import { withLock } from "./lock";
import {
  taskDeliveryPath,
  taskDeliveryRecoveryPath,
  taskDeliveryTombstonePath,
  taskOwnerTransitionOutboxPath,
} from "./paths";
import { readConfig, withCurrentSessionBinding } from "./teams";
import { writeJsonAtomic } from "./atomic-json";
import { Check } from "typebox/value";
import { TaskCardSchema, type TaskCard } from "../model-tool-contract/task-domain";
import type { TaskVersionRef } from "../model-tool-contract/task-version-ref";

export const TASK_CHANGE_CUSTOM_TYPE = "pi-teams.task-change";
export const TASK_CHANGE_RESUME_TYPE = "pi-teams.task-change-resume";
export const TASK_CHANGE_ACK_ENTRY_TYPE = "pi-teams.task-change-successful-turn-ack";
export const TASK_POLL_MS_ENV = "PI_TEAMS_TASK_POLL_MS";
export const DEFAULT_TASK_POLL_MS = 30_000;

export type TaskChangeKind =
  | "assigned"
  | "ownership_lost"
  | "status_changed"
  | "relation_changed"
  | "note_appended"
  | "task_changed";

export interface TaskChangeRef {
  kind: "task";
  /** Canonical Task identity and opaque public revision. */
  taskId: string;
  version: TaskVersionRef;
}

export type TaskChangeTaskProjection = TaskCard;
/** Coordinates used only while preparing an ownership transition. */
type TaskCoordinates = Pick<TaskCard, "id" | "title" | "status" | "assignee" | "version">;

export interface TaskDeliveryRecord {
  deliveryId: string;
  ref: TaskChangeRef;
  changeKind: TaskChangeKind;
  teamName: string;
  recipient: string;
  /** Exact Team membership generation addressed by this pending change. */
  recipientMembershipId: string;
  /** Current adapter binding. Generic identity remains the Session trace. */
  recipientSessionFile: string;
  targetAgentRef: { kind: "session-trace"; nativeId: string };
  /** Canonical task_read card captured at publication. */
  taskProjection: TaskChangeTaskProjection;
  queuedAt: string;
  attemptedAt?: string;
  attemptCount: number;
  successfulTurnAckAt?: string;
}

export interface TaskDeliveryTombstone {
  deliveryId: string;
  ref: TaskChangeRef;
  recipient: string;
  recipientMembershipId: string;
  recipientSessionFile: string;
  observedAt: string;
  evidence: "successful-turn-ack" | "tool-post-state";
}

export interface TaskDeliveryRecoveryRecord {
  teamName: string;
  taskId: string;
  taskVersion: TaskVersionRef;
  recipients: string[];
  changeKind: TaskChangeKind;
  recordedAt: string;
  reason: "enqueue-failed";
  /** Canonical task_read card captured before the enqueue attempt. */
  taskProjection: TaskChangeTaskProjection;
  resolvedRecipients?: string[];
}

export interface OwnerTransitionTarget {
  recipient: string;
  recipientMembershipId: string;
  recipientSessionFile: string;
  changeKind: "ownership_lost" | "assigned";
}

export interface OwnerTransitionIntent {
  operationId: string;
  teamName: string;
  taskId: string;
  beforeVersion: TaskVersionRef;
  beforeOwner?: string;
  afterOwner?: string;
  targets: OwnerTransitionTarget[];
  createdAt: string;
  state: "prepared" | "committed" | "abandoned";
  /** Canonical task_read card captured with the committed Task. */
  committedTaskProjection?: TaskChangeTaskProjection;
  /** Raw authority revision needed to reconstruct the internal delivery ref. */
  committedTaskVersion?: TaskVersionRef;
  resolvedTargetKeys?: string[];
}

export interface OwnerTransitionOutboxDependencies {
  readEvidence?: (taskId: string) => Promise<{ task: TaskCard; operationId?: string }>;
  enqueueExact?: (
    config: TeamConfig,
    task: TaskCard,
    target: OwnerTransitionTarget,
  ) => Promise<TaskDeliveryRecord | null>;
}

export interface TaskChangeBatchDetails {
  authority: "pi-teams-task-delivery";
  schemaVersion: 1;
  teamName: string;
  recipient: string;
  recipientMembershipId: string;
  targetAgentRef: { kind: "session-trace"; nativeId: string };
  deliveryIds: string[];
  changes: Array<{ ref: TaskChangeRef; changeKind: TaskChangeKind }>;
}

export interface TaskChangeBatch {
  customType: typeof TASK_CHANGE_CUSTOM_TYPE;
  content: string;
  display: true;
  details: TaskChangeBatchDetails;
}

export interface TaskDeliverySink {
  sendMessage(
    message: TaskChangeBatch | {
      customType: typeof TASK_CHANGE_RESUME_TYPE;
      content: string;
      display: false;
      details: TaskChangeBatchDetails;
    },
    options: { triggerTurn: true; deliverAs: "steer" },
  ): void;
  appendEntry(customType: typeof TASK_CHANGE_ACK_ENTRY_TYPE, data: TaskChangeBatchDetails): void;
}

interface ContextMessage { role?: unknown; customType?: unknown; details?: unknown }

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sessionRef(sessionFile: string) {
  const match = path.basename(sessionFile).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i);
  return {
    kind: "session-trace" as const,
    nativeId: match ? `pi-session_${match[1].toLowerCase()}` : `session_${digest(sessionFile).slice(0, 24)}`,
  };
}

/** Validate the exact canonical card supplied by the Task adapter. */
export function projectTaskForAgent(task: TaskCard): TaskChangeTaskProjection {
  if (!Check(TaskCardSchema, task)) {
    const error = new Error("Task delivery requires the canonical TaskCard supplied by the adapter.");
    error.name = "upgrade_required";
    throw error;
  }
  assertTaskVersionRef(task.version);
  return structuredClone(task);
}

function recipientBinding(config: TeamConfig, recipient: string): { membershipId: string; sessionFile: string } | null {
  const member = [...config.members].reverse().find((candidate) => candidate.name === recipient && candidate.isActive !== false);
  if (!member?.membershipId || !member.sessionFile) return null;
  return { membershipId: member.membershipId, sessionFile: member.sessionFile };
}

export function taskPollMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env[TASK_POLL_MS_ENV]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TASK_POLL_MS;
}

/**
 * Persist Task-adapter delivery evidence after a successful Task mutation.
 * The Task backend remains the only authority for Task business state.
 */
export async function enqueueTaskChange(teamName: string, task: TaskCard, changeKind: TaskChangeKind, actor?: string): Promise<TaskDeliveryRecord | null> {
  if (!task.assignee) return null;
  return enqueueTaskChangeForRecipient(teamName, task, task.assignee, changeKind);
}

export async function enqueueTaskChangeForRecipient(teamName: string, task: TaskCard, recipient: string, changeKind: TaskChangeKind): Promise<TaskDeliveryRecord | null> {
  const config = await readConfig(teamName);
  return enqueueTaskChangeWithConfig(config, task, recipient, changeKind);
}

export async function enqueueTaskChangeForExactRecipient(config: TeamConfig, task: TaskCard, target: OwnerTransitionTarget): Promise<TaskDeliveryRecord | null> {
  return enqueueTaskChangeWithConfig(
    config,
    task,
    target.recipient,
    target.changeKind,
    { membershipId: target.recipientMembershipId, sessionFile: target.recipientSessionFile },
  );
}

async function enqueueTaskChangeWithConfig(
  config: TeamConfig,
  task: TaskCard,
  recipient: string,
  changeKind: TaskChangeKind,
  exactBinding?: { membershipId: string; sessionFile: string },
): Promise<TaskDeliveryRecord | null> {
  const card = projectTaskForAgent(task);
  return enqueueTaskProjectionWithConfig(config, card, recipient, changeKind, exactBinding);
}

async function enqueueTaskProjectionWithConfig(
  config: TeamConfig,
  taskProjection: TaskChangeTaskProjection,
  recipient: string,
  changeKind: TaskChangeKind,
  exactBinding?: { membershipId: string; sessionFile: string },
): Promise<TaskDeliveryRecord | null> {
  const card = projectTaskForAgent(taskProjection);
  const taskId = card.id;
  const version = assertTaskVersionRef(card.version);
  const teamName = config.name;
  const binding = recipientBinding(config, recipient);
  if (!binding) return null;
  if (
    exactBinding
    && (binding.membershipId !== exactBinding.membershipId || binding.sessionFile !== exactBinding.sessionFile)
  ) return null;
  const recipientSessionFile = binding.sessionFile;
  const recipientMembershipId = binding.membershipId;
  const ref: TaskChangeRef = {
    kind: "task",
    taskId,
    version,
  };
  const targetAgentRef = sessionRef(recipientSessionFile);
  const deliveryId = `task_delivery_${digest({ ref, recipient, recipientMembershipId, targetAgentRef }).slice(0, 32)}`;
  const record: TaskDeliveryRecord = {
    deliveryId,
    ref,
    changeKind,
    teamName,
    recipient,
    recipientMembershipId,
    recipientSessionFile,
    targetAgentRef,
    taskProjection: structuredClone(taskProjection),
    queuedAt: new Date().toISOString(),
    attemptCount: 0,
  };
  const file = taskDeliveryPath(teamName, recipient);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, async () => {
    const records = readRecordsUnsafe(file);
    const tombstones = readTombstonesUnsafe(taskDeliveryTombstonePath(teamName, recipient));
    if (tombstones.some((item) => item.deliveryId === deliveryId)) return null;
    const existing = records.find((item) => item.deliveryId === deliveryId || (
      item.ref.taskId === ref.taskId
      && item.ref.version === ref.version
      && item.recipient === recipient
      && item.recipientMembershipId === recipientMembershipId
      && item.recipientSessionFile === recipientSessionFile
    ));
    if (existing) {
      if (!existing.taskProjection) {
        existing.taskProjection = record.taskProjection;
        writeJsonAtomic(file, compactRecords(records));
      }
      return existing;
    }
    records.push(record);
    writeJsonAtomic(file, compactRecords(records));
    return record;
  });
}

function ownerTargetKey(target: OwnerTransitionTarget): string {
  return `${target.recipient}:${target.recipientMembershipId}:${target.recipientSessionFile}:${target.changeKind}`;
}

function readOwnerTransitionIntentsUnsafe(file: string): OwnerTransitionIntent[] {
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(value)) return [];
  if (value.some((record) =>
    (record?.state === "committed" && (!record.committedTaskProjection || !Check(TaskCardSchema, record.committedTaskProjection)
      || (record.committedTaskVersion !== undefined && record.committedTaskProjection.version !== record.committedTaskVersion)))
    || !isTaskVersionRef(record?.beforeVersion)
    || (record?.committedTaskVersion !== undefined && !isTaskVersionRef(record.committedTaskVersion)))) throw upgradeRequired(file);
  return value as OwnerTransitionIntent[];
}

function compactOwnerTransitionIntents(records: OwnerTransitionIntent[]): OwnerTransitionIntent[] {
  const incomplete = records.filter((record) =>
    record.state === "prepared"
    || (record.state === "committed" && record.targets.some((target) => !record.resolvedTargetKeys?.includes(ownerTargetKey(target))))
  );
  const settled = records.filter((record) => !incomplete.includes(record)).slice(-128);
  return [...incomplete, ...settled];
}

function ownerTransitionTargets(
  config: TeamConfig,
  beforeOwner: string | undefined,
  afterOwner: string | undefined,
): OwnerTransitionTarget[] {
  const targets: OwnerTransitionTarget[] = [];
  const append = (recipient: string | undefined, changeKind: OwnerTransitionTarget["changeKind"]) => {
    if (!recipient) return;
    const binding = recipientBinding(config, recipient);
    if (!binding) return;
    targets.push({
      recipient,
      recipientMembershipId: binding.membershipId,
      recipientSessionFile: binding.sessionFile,
      changeKind,
    });
  };
  append(beforeOwner, "ownership_lost");
  append(afterOwner, "assigned");
  return targets;
}

/**
 * Persist adapter delivery intent before the authoritative assignee mutation.
 * The returned boolean controls whether the operation ID is embedded in the
 * same Beads command. A same-assignee write is not an ownership transition.
 */
export async function prepareOwnerTransitionIntent(input: {
  operationId: string;
  teamName: string;
  before: TaskCard;
  afterOwner?: string;
  previousOperationId?: string;
}): Promise<boolean> {
  const afterOwner = input.afterOwner || undefined;
  if (input.before.assignee === afterOwner) {
    if (!input.previousOperationId) return false;
    const file = taskOwnerTransitionOutboxPath(input.teamName);
    if (!fs.existsSync(file)) return false;
    await withLock(file, async () => {
      const records = readOwnerTransitionIntentsUnsafe(file);
      const prior = records.find((record) =>
        record.taskId === input.before.id
        && record.state === "prepared"
        && record.operationId === input.previousOperationId
        && record.afterOwner === input.before.assignee
      );
      if (prior) {
        prior.state = "committed";
        prior.committedTaskVersion = assertTaskVersionRef(input.before.version);
        prior.committedTaskProjection = projectTaskForAgent(input.before);
        writeJsonAtomic(file, compactOwnerTransitionIntents(records));
      }
    });
    await deliverCommittedOwnerTransitionIntents(input.teamName);
    return false;
  }
  const config = await readConfig(input.teamName);
  if (config.taskBackend !== "beads" || !config.taskWorkspace || !config.taskAuthorityId || !config.taskAuthorityFingerprint) {
    throw new Error(`Team ${config.name} has no configured Beads Task authority; Task delivery refuses legacy fallback.`);
  }
  const file = taskOwnerTransitionOutboxPath(input.teamName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await withLock(file, async () => {
    const records = readOwnerTransitionIntentsUnsafe(file);
    for (const record of records) {
      if (record.taskId !== input.before.id || record.state !== "prepared") continue;
      if (
        record.operationId === input.previousOperationId
        && record.afterOwner === input.before.assignee
      ) {
        record.state = "committed";
        record.committedTaskVersion = assertTaskVersionRef(input.before.version);
        record.committedTaskProjection = projectTaskForAgent(input.before);
      } else if (
        record.beforeVersion === assertTaskVersionRef(input.before.version)
        && record.beforeOwner === input.before.assignee
      ) {
        record.state = "abandoned";
      }
    }
    if (!records.some((record) => record.operationId === input.operationId)) {
      records.push({
        operationId: input.operationId,
        teamName: input.teamName,
        taskId: input.before.id,
        beforeVersion: assertTaskVersionRef(input.before.version),
        beforeOwner: input.before.assignee,
        afterOwner,
        targets: ownerTransitionTargets(config, input.before.assignee, afterOwner),
        createdAt: new Date().toISOString(),
        state: "prepared",
      });
    }
    writeJsonAtomic(file, compactOwnerTransitionIntents(records));
  });
  // A later assignee mutation is the last safe point to settle the previous
  // marker before the authority overwrites it. Delivery failure stays pending.
  await deliverCommittedOwnerTransitionIntents(input.teamName);
  return true;
}

/** Mark a known authority commit and attempt both exact-recipient deliveries. */
export async function completeOwnerTransitionIntent(
  teamName: string,
  operationId: string,
  task: TaskCard,
  dependencies: OwnerTransitionOutboxDependencies = {},
): Promise<string[]> {
  const postStateCard = projectTaskForAgent(task);
  const file = taskOwnerTransitionOutboxPath(teamName);
  if (!fs.existsSync(file)) return [`Owner transition ${operationId} committed without a local delivery intent`];
  await withLock(file, async () => {
    const records = readOwnerTransitionIntentsUnsafe(file);
    const record = records.find((candidate) => candidate.operationId === operationId);
    if (!record) return;
    if (record.taskId !== task.id || record.afterOwner !== task.assignee) {
      throw new Error(`Owner transition ${operationId} post-state does not match its prepared intent.`);
    }
    record.state = "committed";
    record.committedTaskVersion = assertTaskVersionRef(postStateCard.version);
    record.committedTaskProjection = structuredClone(postStateCard);
    writeJsonAtomic(file, compactOwnerTransitionIntents(records));
  });
  return deliverCommittedOwnerTransitionIntents(teamName, dependencies);
}

/**
 * Recover prepared intents only when Beads confirms the embedded operation ID.
 * An unchanged pre-state can be an in-flight writer, so it remains prepared.
 * Only a matching authority marker proves commit; all other evidence is retained.
 */
export async function reconcileOwnerTransitionOutbox(
  teamName: string,
  dependencies: OwnerTransitionOutboxDependencies = {},
): Promise<string[]> {
  const config = await readConfig(teamName);
  if (config.taskBackend !== "beads" || !config.taskWorkspace || !config.taskAuthorityId || !config.taskAuthorityFingerprint) return [];
  const file = taskOwnerTransitionOutboxPath(teamName);
  if (!fs.existsSync(file)) return [];
  const prepared = readOwnerTransitionIntentsUnsafe(file).filter((record) => record.state === "prepared");
  const evidence = new Map<string, { task: TaskCard; operationId?: string }>();
  for (const record of prepared) {
    if (!evidence.has(record.taskId)) {
      evidence.set(
        record.taskId,
        await (dependencies.readEvidence?.(record.taskId) ?? (await import("../model-tool-contract/beads-task-adapter.js")).readTaskOwnerTransitionEvidence(teamName, record.taskId)),
      );
    }
  }
  await withLock(file, async () => {
    const records = readOwnerTransitionIntentsUnsafe(file);
    for (const record of records) {
      if (record.state !== "prepared") continue;
      const current = evidence.get(record.taskId);
      if (!current) continue;
      if (
        current.operationId === record.operationId
        && current.task.assignee === record.afterOwner
      ) {
        record.state = "committed";
        record.committedTaskVersion = assertTaskVersionRef(current.task.version);
        record.committedTaskProjection = projectTaskForAgent(current.task);
      }
    }
    writeJsonAtomic(file, compactOwnerTransitionIntents(records));
  });
  return deliverCommittedOwnerTransitionIntents(teamName, dependencies);
}

async function deliverCommittedOwnerTransitionIntents(
  teamName: string,
  dependencies: OwnerTransitionOutboxDependencies = {},
): Promise<string[]> {
  const file = taskOwnerTransitionOutboxPath(teamName);
  if (!fs.existsSync(file)) return [];
  const config = await readConfig(teamName);
  const warnings: string[] = [];
  await withLock(file, async () => {
    const records = readOwnerTransitionIntentsUnsafe(file);
    for (const record of records) {
      if (record.state !== "committed") continue;
      const projection = record.committedTaskProjection;
      if (!projection) continue;
      for (const target of record.targets) {
        const key = ownerTargetKey(target);
        if (record.resolvedTargetKeys?.includes(key)) continue;
        const current = recipientBinding(config, target.recipient);
        if (
          !current
          || current.membershipId !== target.recipientMembershipId
          || current.sessionFile !== target.recipientSessionFile
        ) {
          record.resolvedTargetKeys = [...new Set([...(record.resolvedTargetKeys || []), key])];
          continue;
        }
        try {
          if (dependencies.enqueueExact) {
            await dependencies.enqueueExact(config, projection, target);
          } else {
            await enqueueTaskProjectionWithConfig(
              config,
              projection,
              target.recipient,
              target.changeKind,
              { membershipId: target.recipientMembershipId, sessionFile: target.recipientSessionFile },
            );
          }
          record.resolvedTargetKeys = [...new Set([...(record.resolvedTargetKeys || []), key])];
        } catch (error) {
          warnings.push(
            `Owner transition ${record.operationId} committed but delivery enqueue for ${target.recipient} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    writeJsonAtomic(file, compactOwnerTransitionIntents(records));
  });
  return warnings;
}

export async function readOwnerTransitionIntents(teamName: string): Promise<OwnerTransitionIntent[]> {
  const file = taskOwnerTransitionOutboxPath(teamName);
  if (!fs.existsSync(file)) return [];
  return withLock(file, async () => readOwnerTransitionIntentsUnsafe(file));
}

/** Rebuild latest assignee-addressed delivery intent after a commit/spool crash gap. */
export async function reconcileTaskChanges(teamName: string, recipient: string): Promise<number> {
  const config = await readConfig(teamName);
  if (config.taskBackend !== "beads" || !config.taskWorkspace || !config.taskAuthorityId || !config.taskAuthorityFingerprint) {
    return 0;
  }
  await reconcileOwnerTransitionOutbox(teamName);
  const { BeadsTaskAdapter } = await import("../model-tool-contract/beads-task-adapter.js");
  const { listTaskIds } = await import("../model-tool-contract/beads-authority-adapter.js");
  const hydrated = await new BeadsTaskAdapter(teamName, "task-delivery-reconciliation")
    .readMany(await listTaskIds(teamName));
  const existing = await readTaskDeliveries(teamName, recipient);
  const tombstones = await readTaskDeliveryTombstones(teamName, recipient);
  const known = new Set([...existing.map((record) => record.deliveryId), ...tombstones.map((record) => record.deliveryId)]);
  let reconciled = 0;
  for (const result of hydrated) {
    if (!result || result.kind === "contract_gap") {
      if (result?.kind === "contract_gap") throw upgradeRequired(`Task ${result.taskId} cannot be reconciled without canonical Task metadata.`);
      continue;
    }
    const task = result.task;
    if (task.assignee !== recipient) continue;
    const record = await enqueueTaskChangeWithConfig(config, task, recipient, "task_changed");
    if (record && !known.has(record.deliveryId)) {
      known.add(record.deliveryId);
      reconciled += 1;
    }
  }
  reconciled += await reconcileRecoveryRecords(config, recipient);
  return reconciled;
}

async function reconcileRecoveryRecords(config: TeamConfig, recipient: string): Promise<number> {
  const file = taskDeliveryRecoveryPath(config.name);
  if (!fs.existsSync(file)) return 0;
  return withLock(file, async () => {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const records: TaskDeliveryRecoveryRecord[] = Array.isArray(raw)
      ? raw.map((record) => {
        if (!record?.taskProjection || !isTaskVersionRef(record?.taskVersion) || !Check(TaskCardSchema, record.taskProjection) || record.taskProjection.version !== record.taskVersion) throw upgradeRequired(file);
        return record as TaskDeliveryRecoveryRecord;
      })
      : [];
    let count = 0;
    let changed = false;
    for (const record of records) {
      if (!record.recipients.includes(recipient) || record.resolvedRecipients?.includes(recipient)) continue;
      const delivered = record.taskProjection
        ? await enqueueTaskProjectionWithConfig(config, record.taskProjection, recipient, record.changeKind)
        : null;
      if (!delivered) continue;
      record.resolvedRecipients = [...new Set([...(record.resolvedRecipients || []), recipient])];
      changed = true;
      count += 1;
    }
    if (changed) {
      // Unresolved records are never evicted. Fully resolved evidence is bounded.
      const unresolved = records.filter((record) => record.recipients.some((name) => !record.resolvedRecipients?.includes(name)));
      const resolved = records.filter((record) => record.recipients.every((name) => record.resolvedRecipients?.includes(name))).slice(-128);
      writeJsonAtomic(file, [...unresolved, ...resolved]);
    }
    return count;
  });
}

export async function recordTaskDeliveryRecovery(record: TaskDeliveryRecoveryRecord): Promise<void> {
  if (!Check(TaskCardSchema, record.taskProjection) || !isTaskVersionRef(record.taskVersion) || record.taskProjection.version !== record.taskVersion) {
    throw upgradeRequired(taskDeliveryRecoveryPath(record.teamName));
  }
  const file = taskDeliveryRecoveryPath(record.teamName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await withLock(file, async () => {
    const records: TaskDeliveryRecoveryRecord[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    records.push(record);
    writeJsonAtomic(file, records);
  });
}

export async function readTaskDeliveries(teamName: string, recipient: string): Promise<TaskDeliveryRecord[]> {
  const file = taskDeliveryPath(teamName, recipient);
  if (!fs.existsSync(file)) return [];
  return withLock(file, async () => readRecordsUnsafe(file));
}

export async function readTaskDeliveryTombstones(teamName: string, recipient: string): Promise<TaskDeliveryTombstone[]> {
  const file = taskDeliveryTombstonePath(teamName, recipient);
  if (!fs.existsSync(file)) return [];
  return withLock(file, async () => readTombstonesUnsafe(file));
}

async function mutateRecords(
  teamName: string,
  recipient: string,
  ids: Iterable<string>,
  mutate: (record: TaskDeliveryRecord) => void,
): Promise<number> {
  const wanted = new Set(ids);
  if (wanted.size === 0) return 0;
  const file = taskDeliveryPath(teamName, recipient);
  if (!fs.existsSync(file)) return 0;
  return withLock(file, async () => {
    const records = readRecordsUnsafe(file);
    let count = 0;
    for (const record of records) {
      if (!wanted.has(record.deliveryId)) continue;
      mutate(record);
      count++;
    }
    if (count > 0) writeJsonAtomic(file, compactRecords(records));
    return count;
  });
}

function isTaskVersionRef(value: unknown): value is TaskVersionRef {
  return typeof value === "string" && /^v_[0-9a-f]{16}$/.test(value);
}

function assertTaskVersionRef(value: string): TaskVersionRef {
  if (!isTaskVersionRef(value)) {
    const error = new Error("Task delivery requires the canonical opaque TaskVersionRef supplied by the adapter.");
    error.name = "upgrade_required";
    throw error;
  }
  return value;
}

function upgradeRequired(file: string): Error {
  const error = new Error(`Task delivery records at ${file} require the stopped-epoch migration before this runtime can start.`);
  error.name = "upgrade_required";
  return error;
}

function readRecordsUnsafe(file: string): TaskDeliveryRecord[] {
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(value)) return [];
  if (value.some((record) => !record?.taskProjection || !Check(TaskCardSchema, record.taskProjection) || !isTaskVersionRef(record?.ref?.version) || record.taskProjection.version !== record.ref.version || "authorityId" in (record?.ref ?? {}) || "nativeId" in (record?.ref ?? {}))) throw upgradeRequired(file);
  return value as TaskDeliveryRecord[];
}

function readTombstonesUnsafe(file: string): TaskDeliveryTombstone[] {
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(value)) return [];
  if (value.some((record) => !isTaskVersionRef(record?.ref?.version) || "authorityId" in (record?.ref ?? {}) || "nativeId" in (record?.ref ?? {}))) throw upgradeRequired(file);
  return value as TaskDeliveryTombstone[];
}

function compactRecords(records: TaskDeliveryRecord[]): TaskDeliveryRecord[] {
  const settledLimit = 128;
  const pending = records.filter((record) => !record.successfulTurnAckAt);
  const settled = records.filter((record) => !!record.successfulTurnAckAt).slice(-settledLimit);
  return [...pending, ...settled];
}

async function persistTombstones(
  teamName: string,
  recipient: string,
  tombstones: TaskDeliveryTombstone[],
): Promise<void> {
  if (tombstones.length === 0) return;
  const file = taskDeliveryTombstonePath(teamName, recipient);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await withLock(file, async () => {
    const existing = readTombstonesUnsafe(file);
    const byTaskSession = new Map<string, TaskDeliveryTombstone>();
    for (const item of [...existing, ...tombstones]) {
      byTaskSession.set(`${item.ref.taskId}:${item.recipientMembershipId}:${item.recipientSessionFile}`, item);
    }
    writeJsonAtomic(file, [...byTaskSession.values()]);
  });
}

export async function suppressTaskVersionForSession(
  teamName: string,
  recipient: string,
  sessionFile: string,
  task: TaskCard | TaskCoordinates,
): Promise<void> {
  const config = await readConfig(teamName);
  const binding = recipientBinding(config, recipient);
  if (!binding || binding.sessionFile !== sessionFile) {
    throw new Error(`Cannot suppress Task delivery for ${recipient}: the acting Session is not its current active binding.`);
  }
  const ref: TaskChangeRef = { kind: "task", taskId: task.id, version: assertTaskVersionRef(task.version) };
  const targetAgentRef = sessionRef(sessionFile);
  const deliveryId = `task_delivery_${digest({ ref, recipient, recipientMembershipId: binding.membershipId, targetAgentRef }).slice(0, 32)}`;
  await persistTombstones(teamName, recipient, [{
    deliveryId,
    ref,
    recipient,
    recipientMembershipId: binding.membershipId,
    recipientSessionFile: sessionFile,
    observedAt: new Date().toISOString(),
    evidence: "tool-post-state",
  }]);
}

function detailsFrom(value: unknown): TaskChangeBatchDetails | null {
  if (!value || typeof value !== "object") return null;
  const details = value as Partial<TaskChangeBatchDetails>;
  if (
    details.authority !== "pi-teams-task-delivery"
    || details.schemaVersion !== 1
    || typeof details.teamName !== "string"
    || typeof details.recipient !== "string"
    || typeof details.recipientMembershipId !== "string"
    || !Array.isArray(details.deliveryIds)
    || !Array.isArray(details.changes)
  ) return null;
  return details as TaskChangeBatchDetails;
}

function idsFromCustom(customType: unknown, raw: unknown, teamName: string, recipient: string): string[] {
  if (customType !== TASK_CHANGE_CUSTOM_TYPE) return [];
  const details = detailsFrom(raw);
  if (!details || details.teamName !== teamName || details.recipient !== recipient) return [];
  return details.deliveryIds;
}

export function acknowledgedTaskDeliveryIdsFromEntries(entries: readonly SessionEntry[], teamName: string, recipient: string, recipientMembershipId?: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== TASK_CHANGE_ACK_ENTRY_TYPE) continue;
    const details = detailsFrom(entry.data);
    if (!details || details.teamName !== teamName || details.recipient !== recipient || (recipientMembershipId && details.recipientMembershipId !== recipientMembershipId)) continue;
    for (const id of details.deliveryIds) ids.add(id);
  }
  return ids;
}

export function presentedTaskDeliveryIdsFromEntries(entries: readonly SessionEntry[], teamName: string, recipient: string, recipientMembershipId?: string): Set<string> {
  const observed = acknowledgedTaskDeliveryIdsFromEntries(entries, teamName, recipient, recipientMembershipId);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom_message") continue;
    const details = detailsFrom(entry.details);
    if (recipientMembershipId && details?.recipientMembershipId !== recipientMembershipId) continue;
    for (const id of idsFromCustom(entry.customType, entry.details, teamName, recipient)) {
      if (!observed.has(id)) ids.add(id);
    }
  }
  return ids;
}

function contextIds(messages: readonly ContextMessage[], teamName: string, recipient: string, recipientMembershipId: string): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "custom") continue;
    const details = detailsFrom(message.details);
    if (details?.recipientMembershipId !== recipientMembershipId) continue;
    for (const id of idsFromCustom(message.customType, message.details, teamName, recipient)) ids.add(id);
  }
  return ids;
}

function formatBatch(records: TaskDeliveryRecord[]): string {
  return [
    "[PiTeams Task changes]",
    "These changes were already accepted by the Task authority. The payload is a versioned snapshot for action, not a substitute for task_read/task_list when you need current state.",
    JSON.stringify({
      changes: records.map((record) => ({
        task: record.taskProjection,
      })),
    }, null, 2),
  ].join("\n");
}

function watchFile(teamName: string, recipient: string, onHint: () => void): () => void {
  const file = taskDeliveryPath(teamName, recipient);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const name = path.basename(file);
  const watcher = fs.watch(path.dirname(file), (_event, filename) => {
    if (!filename || filename.toString() === name) onHint();
  });
  watcher.on("error", () => undefined);
  return () => watcher.close();
}

export class TaskChangeDelivery {
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopWatch: (() => void) | null = null;
  private stopped = true;
  private attempted = new Set<string>();
  private acknowledged = new Set<string>();
  private staged = new Set<string>();
  private scanPromise: Promise<void> | null = null;
  private rescanRequested = false;
  private generation = 0;
  private resolvedMembershipId = "";

  constructor(
    private readonly sink: TaskDeliverySink,
    private readonly options: {
      teamName: string;
      recipient: string;
      membershipId?: string;
      sessionFile: string;
      pollMs?: number;
      /** Test/embedding seam; production defaults to Beads latest-state reconciliation. */
      reconcile?: () => Promise<number>;
      /**
       * Narrow periodic recovery seam. Unlike `reconcile`, this inspects only
       * the local assignee-transition outbox and reads individual Beads Tasks
       * only when a prepared intent needs commit evidence.
       */
      reconcileOwnerOutbox?: () => Promise<string[]>;
    },
  ) {}

  async start(entries: readonly SessionEntry[]): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.stopped = false;
    const initialConfig = await readConfig(this.options.teamName);
    const initialBinding = recipientBinding(initialConfig, this.options.recipient);
    this.resolvedMembershipId = this.options.membershipId || (
      initialBinding?.sessionFile === this.options.sessionFile ? initialBinding.membershipId : ""
    );
    this.attempted.clear();
    this.acknowledged = acknowledgedTaskDeliveryIdsFromEntries(entries, this.options.teamName, this.options.recipient, this.resolvedMembershipId);
    this.staged.clear();
    const observedRecords = (await readTaskDeliveries(this.options.teamName, this.options.recipient))
      .filter((record) => this.acknowledged.has(record.deliveryId));
    await persistTombstones(this.options.teamName, this.options.recipient, observedRecords.map((record) => ({
      deliveryId: record.deliveryId,
      ref: record.ref,
      recipient: record.recipient,
      recipientMembershipId: record.recipientMembershipId,
      recipientSessionFile: record.recipientSessionFile,
      observedAt: new Date().toISOString(),
      evidence: "successful-turn-ack" as const,
    })));
    await mutateRecords(this.options.teamName, this.options.recipient, this.acknowledged, (record) => {
      record.successfulTurnAckAt ||= new Date().toISOString();
    });
    if (this.stopped || generation !== this.generation) return;
    await (this.options.reconcile?.() ?? reconcileTaskChanges(this.options.teamName, this.options.recipient));
    if (this.stopped || generation !== this.generation) return;
    const presented = presentedTaskDeliveryIdsFromEntries(entries, this.options.teamName, this.options.recipient, this.resolvedMembershipId);
    for (const id of presented) this.attempted.add(id);
    this.stopWatch = watchFile(this.options.teamName, this.options.recipient, () => void this.scan().catch(() => undefined));
    this.interval = setInterval(() => void this.scan().catch(() => undefined), this.options.pollMs ?? DEFAULT_TASK_POLL_MS);
    if (presented.size > 0) {
      const records = (await this.eligible()).filter((record) => presented.has(record.deliveryId));
      if (this.stopped || generation !== this.generation) return;
      if (records.length > 0) this.sink.sendMessage({
        customType: TASK_CHANGE_RESUME_TYPE,
        content: "Resume the already-recorded Task changes. Full payloads are in preceding canonical custom entries.",
        display: false,
        details: this.details(records),
      }, { triggerTurn: true, deliverAs: "steer" });
    }
    await this.scan();
  }

  stop(): void {
    this.generation += 1;
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    this.stopWatch?.();
    this.interval = null;
    this.stopWatch = null;
    this.scanPromise = null;
    this.rescanRequested = false;
    this.staged.clear();
  }

  async scan(): Promise<void> {
    if (this.stopped) return;
    if (this.scanPromise) {
      this.rescanRequested = true;
      return this.scanPromise;
    }
    const promise = this.scanLoop(this.generation);
    this.scanPromise = promise;
    try {
      await promise;
    } finally {
      if (this.scanPromise === promise) this.scanPromise = null;
    }
  }

  private async scanLoop(generation: number): Promise<void> {
    do {
      this.rescanRequested = false;
      await this.scanOnce(generation);
    } while (this.rescanRequested && !this.stopped && generation === this.generation);
  }

  async observeContext(messages: readonly ContextMessage[]): Promise<number> {
    if (this.stopped) return 0;
    const ids = new Set([...contextIds(messages, this.options.teamName, this.options.recipient, this.resolvedMembershipId)].filter((id) => !this.acknowledged.has(id)));
    const records = (await this.eligible()).filter((record) => ids.has(record.deliveryId) && !this.staged.has(record.deliveryId));
    if (this.stopped || records.length === 0) return 0;
    for (const record of records) this.staged.add(record.deliveryId);
    return records.length;
  }

  async commitPresentedAfterSuccessfulTurn(stopReason: unknown): Promise<number> {
    if (this.stopped || stopReason === "error" || stopReason === "aborted") return 0;
    if (!await this.isCurrentBinding()) {
      this.stop();
      return 0;
    }
    const ids = new Set([...this.staged].filter((id) => !this.acknowledged.has(id)));
    if (ids.size === 0) return 0;
    const records = (await this.eligible()).filter((record) => ids.has(record.deliveryId));
    if (this.stopped || records.length === 0) return 0;
    const count = await withCurrentSessionBinding(
      this.options.teamName,
      this.options.recipient,
      this.options.sessionFile,
      this.resolvedMembershipId,
      async () => {
        const details = this.details(records);
        this.sink.appendEntry(TASK_CHANGE_ACK_ENTRY_TYPE, details);
        await persistTombstones(this.options.teamName, this.options.recipient, records.map((record) => ({
          deliveryId: record.deliveryId,
          ref: record.ref,
          recipient: record.recipient,
          recipientMembershipId: record.recipientMembershipId,
          recipientSessionFile: record.recipientSessionFile,
          observedAt: new Date().toISOString(),
          evidence: "successful-turn-ack" as const,
        })));
        return mutateRecords(this.options.teamName, this.options.recipient, ids, (record) => {
          record.successfulTurnAckAt ||= new Date().toISOString();
        });
      },
    );
    for (const id of ids) {
      this.acknowledged.add(id);
      this.staged.delete(id);
    }
    return count;
  }

  private async scanOnce(generation: number): Promise<void> {
    try {
      await (
        this.options.reconcileOwnerOutbox?.()
        ?? reconcileOwnerTransitionOutbox(this.options.teamName)
      );
    } catch (error) {
      // Owner-transition recovery is independent of already-persisted recipient
      // delivery. A transient Beads/outbox failure must not head-of-line block
      // unrelated records that are ready in the local spool.
      console.error(
        `[pi-teams] assignee-transition recovery failed for team ${this.options.teamName}; continuing local Task delivery:`,
        error,
      );
    }
    if (this.stopped || generation !== this.generation) return;
    const records = (await this.eligible()).filter((record) => !record.successfulTurnAckAt && !this.attempted.has(record.deliveryId));
    if (this.stopped || generation !== this.generation || records.length === 0) return;
    for (const record of records) this.attempted.add(record.deliveryId);
    await mutateRecords(this.options.teamName, this.options.recipient, records.map((r) => r.deliveryId), (record) => {
      record.attemptedAt = new Date().toISOString();
      record.attemptCount += 1;
    });
    if (this.stopped || generation !== this.generation) return;
    if (!await this.isCurrentBinding()) {
      this.stop();
      return;
    }
    try {
      await withCurrentSessionBinding(
        this.options.teamName,
        this.options.recipient,
        this.options.sessionFile,
        this.resolvedMembershipId,
        async () => this.sink.sendMessage({ customType: TASK_CHANGE_CUSTOM_TYPE, content: formatBatch(records), display: true, details: this.details(records) }, { triggerTurn: true, deliverAs: "steer" }),
      );
    } catch (error) {
      for (const record of records) this.attempted.delete(record.deliveryId);
      throw error;
    }
  }

  private async eligible(): Promise<TaskDeliveryRecord[]> {
    const config = await readConfig(this.options.teamName);
    const binding = recipientBinding(config, this.options.recipient);
    if (!this.resolvedMembershipId || !binding || binding.membershipId !== this.resolvedMembershipId || binding.sessionFile !== this.options.sessionFile) return [];
    const tombstones = new Set((await readTaskDeliveryTombstones(this.options.teamName, this.options.recipient)).map((item) => item.deliveryId));
    return (await readTaskDeliveries(this.options.teamName, this.options.recipient))
      .filter((record) => record.recipientMembershipId === this.resolvedMembershipId && record.recipientSessionFile === this.options.sessionFile && !tombstones.has(record.deliveryId));
  }

  private async isCurrentBinding(): Promise<boolean> {
    const config = await readConfig(this.options.teamName);
    const binding = recipientBinding(config, this.options.recipient);
    return !!this.resolvedMembershipId
      && binding?.membershipId === this.resolvedMembershipId
      && binding.sessionFile === this.options.sessionFile;
  }

  private details(records: TaskDeliveryRecord[]): TaskChangeBatchDetails {
    return {
      authority: "pi-teams-task-delivery",
      schemaVersion: 1,
      teamName: this.options.teamName,
      recipient: this.options.recipient,
      recipientMembershipId: this.resolvedMembershipId,
      targetAgentRef: sessionRef(this.options.sessionFile),
      deliveryIds: records.map((record) => record.deliveryId),
      changes: records.map((record) => ({ ref: record.ref, changeKind: record.changeKind })),
    };
  }
}
