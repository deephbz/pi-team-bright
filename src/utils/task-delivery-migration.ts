import fs from "node:fs";
import path from "node:path";
import { taskVersionRef } from "../task-authority/task-version-ref";
import type { BeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";
import type { TaskCard } from "../task-authority/task-domain";
import { teamEventJournalPath, teamDir } from "./paths";
import { writeJsonAtomic } from "./atomic-json";

export interface MigrationReceipt {
  scanned: number;
  converted: number;
  unresolved: number;
  failed: number;
}

/** Team-owned stopped-epoch guard required by Task-delivery migration. */
export interface TaskDeliveryStoppedEpochPort {
  isStoppedEpoch(teamName: string): Promise<boolean>;
}

export class UpgradeRequiredError extends Error {
  readonly name = "upgrade_required";
}

function upgradeRequired(message: string): UpgradeRequiredError {
  return new UpgradeRequiredError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function refTaskId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.taskId === "string" ? value.taskId : value.nativeId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function recordTaskId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const snapshot = value.taskSnapshot ?? value.committedTaskSnapshot ?? value.taskProjection;
  if (isRecord(snapshot) && typeof snapshot.id === "string" && snapshot.id.length > 0) return snapshot.id;
  return refTaskId(value.ref) ?? (typeof value.taskId === "string" && value.taskId.length > 0 ? value.taskId : undefined);
}

function eventTaskId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "task") return refTaskId(value.ref);
  if (value.type === "alert") return refTaskId(value.taskRef);
  return undefined;
}

function canonicalVersion(value: unknown): value is `v_${string}` {
  return typeof value === "string" && /^v_[0-9a-f]{16}$/.test(value);
}

function hasLegacyRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return "authorityId" in value || "nativeId" in value || !canonicalVersion(value.version);
}

function deterministicRevision(value: unknown): `v_${string}` {
  return taskVersionRef(String(value));
}

function canonicalRef(
  raw: unknown,
  taskId: string,
): { kind: "task"; taskId: string; version?: `v_${string}` } {
  const ref = isRecord(raw) ? raw : {};
  const version = canonicalVersion(ref.version)
    ? ref.version
    : ref.version === undefined
      ? undefined
      : deterministicRevision(ref.version);
  const { authorityId: _authorityId, nativeId: _nativeId, taskId: _taskId, version: _version, ...evidence } = ref;
  return version
    ? { ...evidence, taskId, version } as { kind: "task"; taskId: string; version: `v_${string}` }
    : { ...evidence, taskId } as { kind: "task"; taskId: string; version?: `v_${string}` };
}

function cardAtVersion(card: TaskCard, version: `v_${string}`): TaskCard {
  return { ...structuredClone(card), version };
}

function writeTextAtomic(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function collectFiles(teamName: string): string[] {
  const root = teamDir(teamName);
  const files: string[] = [];
  const deliveryRoot = path.join(root, "task-delivery");
  if (fs.existsSync(deliveryRoot)) {
    for (const name of fs.readdirSync(deliveryRoot)) {
      const file = path.join(deliveryRoot, name);
      if (fs.statSync(file).isFile()) files.push(file);
    }
  }
  for (const file of [path.join(root, "task-delivery-recovery.json"), path.join(root, "task-owner-transition-outbox.json")]) {
    if (fs.existsSync(file)) files.push(file);
  }
  return files;
}

function recordNeedsMigration(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.taskSnapshot !== undefined || value.committedTaskSnapshot !== undefined) return true;
  if (isRecord(value.ref) && hasLegacyRef(value.ref)) return true;
  if (value.taskVersion !== undefined && !canonicalVersion(value.taskVersion)) return true;
  if (value.beforeVersion !== undefined && !canonicalVersion(value.beforeVersion)) return true;
  if (value.committedTaskVersion !== undefined && !canonicalVersion(value.committedTaskVersion)) return true;
  return false;
}

function migrateRecord(
  teamName: string,
  file: string,
  index: number,
  value: unknown,
  cards: ReadonlyMap<string, TaskCard>,
): { value: unknown; converted: boolean } {
  if (!isRecord(value)) return { value, converted: false };
  const id = recordTaskId(value);
  if (!id || !recordNeedsMigration(value)) return { value, converted: false };
  const card = cards.get(id);
  if (!card) throw upgradeRequired(`Task ${id} cannot be rehydrated from the configured Beads authority.`);
  const next = { ...value };
  delete next.taskSnapshot;
  delete next.committedTaskSnapshot;

  let revision: `v_${string}` | undefined;
  if (isRecord(value.ref)) {
    const ref = canonicalRef(value.ref, id);
    revision = ref.version;
    next.ref = ref;
  }
  if (value.taskVersion !== undefined && !canonicalVersion(value.taskVersion)) {
    revision = canonicalVersion(value.taskVersion) ? value.taskVersion : deterministicRevision(value.taskVersion);
    next.taskVersion = revision;
  }
  if (value.beforeVersion !== undefined && !canonicalVersion(value.beforeVersion)) {
    next.beforeVersion = canonicalVersion(value.beforeVersion) ? value.beforeVersion : deterministicRevision(value.beforeVersion);
  }
  if (value.committedTaskVersion !== undefined && !canonicalVersion(value.committedTaskVersion)) {
    next.committedTaskVersion = canonicalVersion(value.committedTaskVersion) ? value.committedTaskVersion : deterministicRevision(value.committedTaskVersion);
  }
  if (revision) next.taskProjection = cardAtVersion(card, revision);
  else if (next.taskProjection === undefined) next.taskProjection = structuredClone(card);
  return { value: next, converted: true };
}

function migrateTaskEvent(
  teamName: string,
  value: Record<string, unknown>,
  index: number,
): { value: unknown; converted: boolean; taskId?: string } {
  const taskId = refTaskId(value.ref);
  if (!taskId || !isRecord(value.ref)) throw upgradeRequired(`Malformed Task event at journal line ${index + 1}: a Task identity is required.`);
  const next = { ...value };
  const ref = canonicalRef(value.ref, taskId);
  if (!ref.version) throw upgradeRequired(`Malformed Task event at journal line ${index + 1}: a Task revision is required.`);
  const changed = hasLegacyRef(value.ref) || value.change === "design"
    || JSON.stringify(value.ref) !== JSON.stringify(ref);
  next.ref = ref;
  if (value.change === "design") next.change = "goal";
  return { value: next, converted: changed, taskId };
}

function migrateAlertEvent(
  teamName: string,
  value: Record<string, unknown>,
  index: number,
): { value: unknown; converted: boolean; taskId?: string } {
  if (value.taskRef === undefined) return { value, converted: false };
  if (!isRecord(value.taskRef)) throw upgradeRequired(`Malformed Alert event at journal line ${index + 1}: taskRef must be an object.`);
  const taskId = refTaskId(value.taskRef);
  if (!taskId) throw upgradeRequired(`Malformed Alert event at journal line ${index + 1}: a Task identity is required.`);
  const next = { ...value };
  const rawRef = value.taskRef;
  const publicRef = canonicalRef(rawRef, taskId);
  const changed = hasLegacyRef(rawRef) || JSON.stringify(rawRef) !== JSON.stringify(publicRef);
  next.taskRef = publicRef;
  return { value: next, converted: changed, taskId };
}

function migrateEvent(
  teamName: string,
  value: unknown,
  index: number,
): { value: unknown; converted: boolean; taskId?: string } {
  if (!isRecord(value)) throw upgradeRequired(`Malformed Team event at journal line ${index + 1}: expected an object.`);
  if (value.type === "worker") return { value, converted: false };
  if (value.type === "task") return migrateTaskEvent(teamName, value, index);
  if (value.type === "alert") return migrateAlertEvent(teamName, value, index);
  throw upgradeRequired(`Malformed Team event at journal line ${index + 1}: unknown event type.`);
}

/**
 * Migrate stopped-epoch delivery records through the canonical adapter.
 *
 * The operation performs all parsing, event-type checks, Team-scope checks,
 * and canonical Task reads before it writes any delivery or journal file.
 * Worker events remain evidence-only records and are never Task-normalized.
 */
export async function migrateLegacyTaskDeliveryEpoch(
  teamName: string,
  factory: BeadsTaskAdapterFactory,
  stoppedEpoch: TaskDeliveryStoppedEpochPort,
): Promise<MigrationReceipt> {
  if (!await stoppedEpoch.isStoppedEpoch(teamName)) {
    throw upgradeRequired(`Team ${teamName} is active; stop every Team Membership before running the stopped-epoch migration.`);
  }

  const files = collectFiles(teamName);
  const eventFile = teamEventJournalPath(teamName);
  const eventLines = fs.existsSync(eventFile)
    ? fs.readFileSync(eventFile, "utf8").split("\n").filter(Boolean)
    : [];
  const eventValues = eventLines.map((line, index) => {
    try { return JSON.parse(line) as unknown; }
    catch { throw upgradeRequired(`Malformed Team event journal at line ${index + 1}: invalid JSON.`); }
  });
  const sources = files.map((file) => {
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { throw upgradeRequired(`Legacy Task record file is not valid JSON: ${file}`); }
    if (!Array.isArray(value)) throw upgradeRequired(`Legacy Task record file is not an array: ${file}`);
    return { file, values: value as unknown[] };
  });

  const allIds = new Set<string>();
  const cardIds = new Set<string>();
  for (const source of sources) {
    for (const value of source.values) {
      const id = recordTaskId(value);
      if (!id) continue;
      allIds.add(id);
      if (recordNeedsMigration(value)) cardIds.add(id);
    }
  }
  const eventNeedsMigration: boolean[] = [];
  for (const [index, value] of eventValues.entries()) {
    const id = eventTaskId(value);
    if (id) allIds.add(id);
    const migrated = migrateEvent(teamName, value, index);
    eventNeedsMigration.push(migrated.converted);
  }

  const receipt: MigrationReceipt = {
    scanned: sources.reduce((count, source) => count + source.values.length, 0) + eventValues.length,
    converted: 0,
    unresolved: 0,
    failed: 0,
  };
  if (allIds.size === 0 && cardIds.size === 0 && !eventNeedsMigration.some(Boolean)) return receipt;

  const adapter = factory(teamName, "task-delivery-migration");
  const scopedIds = new Set(await adapter.listIds());
  const outOfScope = [...allIds].filter((id) => !scopedIds.has(id));
  if (outOfScope.length > 0) {
    receipt.failed = outOfScope.length;
    throw upgradeRequired(`Stopped-epoch Task records are outside the configured Team Beads scope: ${outOfScope.join(", ")}.`);
  }
  const ids = [...cardIds];
  const outcomes = ids.length > 0
    ? await adapter.readMany(ids)
    : [];
  const cards = new Map<string, TaskCard>();
  outcomes.forEach((outcome, index) => {
    const id = ids[index];
    if (!outcome || outcome.kind === "contract_gap") {
      receipt.failed++;
      throw upgradeRequired(`Stopped-epoch Task ${id} has no complete canonical Task card; upgrade is required.`);
    }
    cards.set(id, outcome.task);
  });

  const rebuilt = sources.map(({ file, values }) => {
    const nextValues = values.map((value, index) => {
      const result = migrateRecord(teamName, file, index, value, cards);
      if (!result.converted) return value;
      receipt.converted++;
      return result.value;
    });
    return { file, values: nextValues };
  });
  const migratedEvents = eventValues.map((value, index) => {
    const result = migrateEvent(teamName, value, index);
    if (result.converted) receipt.converted++;
    return result.value;
  });

  // Every validation and adapter read completed above. Only now mutate files.
  for (const source of rebuilt) writeJsonAtomic(source.file, source.values);
  if (migratedEvents.some((_, index) => eventNeedsMigration[index])) {
    const lines = migratedEvents.map((value, index) => eventNeedsMigration[index] ? JSON.stringify(value) : eventLines[index]);
    writeTextAtomic(eventFile, `${lines.join("\n")}\n`);
  }
  return receipt;
}
