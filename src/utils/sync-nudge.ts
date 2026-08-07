import fs from "node:fs";
import path from "node:path";
import { syncNudgeRecordPath } from "./paths";

export const SYNC_NUDGE_CUSTOM_TYPE = "pi-team-bright.sync-nudge" as const;

export interface SyncNudgeRecord {
  schema: "pi-team-bright/sync-nudge/1";
  id: string;
  kind: "reserved" | "presented";
  teamName: string;
  teamEpochId: string;
  leaderSessionId: string;
  leaderMembershipId: string;
  /** Full branch lineage at arm time, not only its leaf. */
  branchLineage: string[];
  branchId: string;
  debtKey: string;
  requestedView: "snapshot" | "updates";
  reservedAt: string;
  presentedAt?: string;
  policyVersion: string;
}

export function createSyncNudgeRecord(input: Omit<SyncNudgeRecord, "schema" | "kind"> & { kind?: SyncNudgeRecord["kind"] }): SyncNudgeRecord {
  const values = [input.id, input.teamName, input.teamEpochId, input.leaderSessionId, input.leaderMembershipId, input.branchId, input.debtKey, input.policyVersion, input.reservedAt];
  if (values.some((value) => typeof value !== "string" || value.length === 0)) throw new Error("Sync nudge identity fields must be nonempty strings.");
  if (!Array.isArray(input.branchLineage) || input.branchLineage.length === 0 || input.branchLineage.some((value) => typeof value !== "string" || value.length === 0) || new Set(input.branchLineage).size !== input.branchLineage.length || input.branchLineage.at(-1) !== input.branchId) throw new Error("Sync nudge branch lineage is invalid.");
  if (input.requestedView !== "snapshot" && input.requestedView !== "updates") throw new Error("Sync nudge view is invalid.");
  if (input.kind === "presented" && (typeof input.presentedAt !== "string" || input.presentedAt.length === 0)) throw new Error("Presented sync nudges require presentedAt evidence.");
  return { schema: "pi-team-bright/sync-nudge/1", kind: input.kind ?? "presented", ...input };
}

function appendSyncNudgeRecord(record: SyncNudgeRecord): void {
  const target = syncNudgeRecordPath(record.teamName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, "a", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Reserve before send. A reservation is not presentation evidence. */
export function reserveSyncNudge(record: SyncNudgeRecord): void {
  if (record.kind !== "reserved") throw new Error("Only reserved records can be reserved.");
  appendSyncNudgeRecord(record);
}

/** Promote only after the exact custom message exists in the durable Session branch. */
export function presentSyncNudge(record: SyncNudgeRecord, presentedAt = new Date().toISOString()): SyncNudgeRecord {
  const presented = createSyncNudgeRecord({ ...record, kind: "presented", presentedAt });
  appendSyncNudgeRecord(presented);
  return presented;
}

/** Backward-compatible alias for callers that already hold presented evidence. */
export function recordSyncNudge(record: SyncNudgeRecord): void {
  if (record.kind !== "presented") throw new Error("recordSyncNudge requires presented evidence.");
  appendSyncNudgeRecord(record);
}

export function validateSyncNudgeRecord(value: unknown): SyncNudgeRecord | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as SyncNudgeRecord;
    if (record.schema !== "pi-team-bright/sync-nudge/1") return undefined;
    const { schema: _schema, ...input } = record;
    return createSyncNudgeRecord(input);
  } catch {
    return undefined;
  }
}

export function readSyncNudgeRecords(teamName: string): SyncNudgeRecord[] {
  const target = syncNudgeRecordPath(teamName);
  if (!fs.existsSync(target)) return [];
  const latest = new Map<string, SyncNudgeRecord>();
  for (const line of fs.readFileSync(target, "utf8").split("\n").filter(Boolean)) {
    try {
      const record = validateSyncNudgeRecord(JSON.parse(line));
      if (record?.teamName === teamName) latest.set(record.id, record);
    } catch {
      // A malformed derived receipt does not affect Team authority.
    }
  }
  return [...latest.values()];
}

export function readSyncNudges(teamName: string): SyncNudgeRecord[] {
  return readSyncNudgeRecords(teamName).filter((record) => record.kind === "presented");
}

export function findSyncNudgeReservation(teamName: string, debtKey: string, branchLineage: readonly string[]): SyncNudgeRecord | undefined {
  return readSyncNudgeRecords(teamName).find((record) => record.kind === "reserved" && record.debtKey === debtKey && record.branchLineage.length === branchLineage.length && record.branchLineage.every((value, index) => value === branchLineage[index]));
}

/** Stable, human-facing projection from the same validated custom-message record. */
export function syncNudgeTuiLine(record: SyncNudgeRecord): string {
  return record.kind === "presented"
    ? `Sync nudge presented; call team_sync({view:"${record.requestedView}"}) to reconcile Team state.`
    : `Sync nudge pending; call team_sync({view:"${record.requestedView}"}) when it is delivered.`;
}

export function syncNudgeContent(record: SyncNudgeRecord): string {
  return `Team state may need reconciliation. Call team_sync({view:"${record.requestedView}"}) now.`;
}
