import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock";
import { teamDir } from "./paths";
import {
  type TeamModelToolContractGap,
  teamModelToolContractGap,
  withCurrentConfig,
} from "./teams";

export const HIDDEN_OBSERVATION_SCHEMA = "pi-teams-hidden-observation/1" as const;

/**
 * Acknowledged, rebuildable coordination position for one exact leader branch.
 * Team and Task authorities remain the source of current state.
 */
export interface HiddenObservationProjection {
  schema: typeof HIDDEN_OBSERVATION_SCHEMA;
  teamEpochId: string;
  exactSessionId: string;
  acknowledgedEntryId: string;
  /** Branch prefix ending at acknowledgedEntryId. */
  acknowledgedLineage: string[];
  teamEventCursor: string;
  authorityRevisions: Record<string, string>;
  updatedAt: string;
}

export interface HiddenObservationCoordinate {
  teamEpochId: string;
  exactSessionId: string;
  branchLineage: string[];
}

export interface CommitHiddenObservationInput extends HiddenObservationCoordinate {
  acknowledgedEntryId: string;
  teamEventCursor: string;
  authorityRevisions?: Record<string, string>;
}

export type ReadHiddenObservationResult =
  | { kind: "found"; projection: HiddenObservationProjection }
  | { kind: "not_found"; reason: "absent" | "lineage_mismatch" }
  | { kind: "coordinate_mismatch"; reason: "team_epoch_mismatch" | "lead_session_mismatch" }
  | TeamModelToolContractGap;

export type CommitHiddenObservationResult =
  | { kind: "committed"; projection: HiddenObservationProjection }
  | {
      kind: "refused";
      reason:
        | "team_epoch_mismatch"
        | "lead_session_mismatch"
        | "acknowledged_entry_not_in_lineage"
        | "stale_acknowledgement"
        | "acknowledgement_conflict";
    }
  | TeamModelToolContractGap;

function hiddenObservationPath(teamName: string, epochId: string, exactSessionId: string): string {
  const epochKey = crypto.createHash("sha256").update(epochId).digest("hex");
  const sessionKey = crypto.createHash("sha256").update(exactSessionId).digest("hex");
  return path.join(teamDir(teamName), "hidden-observations", epochKey, `${sessionKey}.json`);
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateLineage(lineage: readonly string[]): void {
  if (!Array.isArray(lineage) || lineage.length === 0 || lineage.some((entry) => !validString(entry))) {
    throw new Error("Hidden observation branch lineage requires non-empty entry identities.");
  }
  if (new Set(lineage).size !== lineage.length) {
    throw new Error("Hidden observation branch lineage cannot contain duplicate entry identities.");
  }
}

function lineageThroughEntry(lineage: readonly string[], entryId: string): string[] | undefined {
  const index = lineage.indexOf(entryId);
  return index < 0 ? undefined : lineage.slice(0, index + 1);
}

function isPrefix(prefix: readonly string[], lineage: readonly string[]): boolean {
  return prefix.length <= lineage.length && prefix.every((entry, index) => lineage[index] === entry);
}

function currentLeadMatches(config: { members: Array<{ name: string; agentType: string; sessionFile?: string; isActive?: boolean }> }, exactSessionId: string): boolean {
  return config.members.some((member) =>
    member.name === "team-lead"
    && member.agentType === "lead"
    && member.isActive !== false
    && member.sessionFile === exactSessionId
  );
}

function parseProjection(file: string): HiddenObservationProjection {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Hidden observation projection ${file} is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Hidden observation projection ${file} is malformed: expected an object.`);
  }
  const record = value as Partial<HiddenObservationProjection>;
  if (
    record.schema !== HIDDEN_OBSERVATION_SCHEMA
    || !validString(record.teamEpochId)
    || !validString(record.exactSessionId)
    || !validString(record.acknowledgedEntryId)
    || !Array.isArray(record.acknowledgedLineage)
    || !validString(record.teamEventCursor)
    || !/^(0|[1-9][0-9]*)$/.test(record.teamEventCursor)
    || !record.authorityRevisions
    || typeof record.authorityRevisions !== "object"
    || Array.isArray(record.authorityRevisions)
    || Object.entries(record.authorityRevisions).some(([key, revision]) => !key || !validString(revision))
    || !validString(record.updatedAt)
  ) {
    throw new Error(`Hidden observation projection ${file} is malformed: incomplete pi-teams-hidden-observation/1 record.`);
  }
  validateLineage(record.acknowledgedLineage);
  if (record.acknowledgedLineage.at(-1) !== record.acknowledgedEntryId) {
    throw new Error(`Hidden observation projection ${file} is malformed: acknowledged lineage must end at its acknowledged entry.`);
  }
  return record as HiddenObservationProjection;
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    // Directory fsync is not available on every supported local filesystem.
  }
}

/** Hidden records always become mode 0600, including replacement of an unsafe legacy mode. */
function writeProjectionAtomic(file: string, projection: HiddenObservationProjection): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const existing = fs.existsSync(file) ? fs.statSync(file) : undefined;
  if (existing && !existing.isFile()) throw new Error(`Cannot replace hidden observation projection ${file}: existing path is not a regular file.`);
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(projection, null, 2));
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

/** Read only a baseline acknowledged on the supplied active branch lineage. */
export async function readHiddenObservationProjection(
  teamName: string,
  coordinate: HiddenObservationCoordinate,
): Promise<ReadHiddenObservationResult> {
  validateLineage(coordinate.branchLineage);
  if (!coordinate.teamEpochId || !coordinate.exactSessionId) {
    throw new Error("Hidden observation reads require a Team epoch and exact Session identity.");
  }
  return withCurrentConfig(teamName, async (config) => {
    const gap = teamModelToolContractGap(config);
    if (gap) return gap;
    if (config.epochId !== coordinate.teamEpochId) {
      return { kind: "coordinate_mismatch", reason: "team_epoch_mismatch" };
    }
    if (!currentLeadMatches(config, coordinate.exactSessionId)) {
      return { kind: "coordinate_mismatch", reason: "lead_session_mismatch" };
    }
    const file = hiddenObservationPath(teamName, coordinate.teamEpochId, coordinate.exactSessionId);
    return withLock(file, async () => {
      if (!fs.existsSync(file)) return { kind: "not_found", reason: "absent" };
      const projection = parseProjection(file);
      if (
        projection.teamEpochId !== coordinate.teamEpochId
        || projection.exactSessionId !== coordinate.exactSessionId
      ) {
        throw new Error(`Hidden observation projection ${file} does not match its epoch/Session storage key.`);
      }
      return isPrefix(projection.acknowledgedLineage, coordinate.branchLineage)
        ? { kind: "found", projection: structuredClone(projection) }
        : { kind: "not_found", reason: "lineage_mismatch" };
    });
  });
}

/**
 * Commit one result only after Pi supplies its persisted branch entry and
 * lineage. The TeamConfig lock fences epoch/lead replacement; the projection
 * lock serializes same-Session acknowledgements across processes.
 */
export async function commitHiddenObservationProjection(
  teamName: string,
  input: CommitHiddenObservationInput,
): Promise<CommitHiddenObservationResult> {
  validateLineage(input.branchLineage);
  if (!input.teamEpochId || !input.exactSessionId || !input.acknowledgedEntryId) {
    throw new Error("Hidden observation commits require Team epoch, exact Session, and acknowledged entry identities.");
  }
  if (!/^(0|[1-9][0-9]*)$/.test(input.teamEventCursor)) {
    throw new Error(`Invalid Team event cursor ${JSON.stringify(input.teamEventCursor)}.`);
  }
  const acknowledgedLineage = lineageThroughEntry(input.branchLineage, input.acknowledgedEntryId);
  if (!acknowledgedLineage) return { kind: "refused", reason: "acknowledged_entry_not_in_lineage" };
  const authorityRevisionEntries = Object.entries(input.authorityRevisions ?? {});
  if (authorityRevisionEntries.some(([key, revision]) => !key || !validString(revision))) {
    throw new Error("Hidden observation authority revisions require non-empty authority and revision strings.");
  }
  const authorityRevisions = Object.fromEntries(
    authorityRevisionEntries.sort(([left], [right]) => left.localeCompare(right)),
  );

  return withCurrentConfig(teamName, async (config) => {
    const gap = teamModelToolContractGap(config);
    if (gap) return gap;
    if (config.epochId !== input.teamEpochId) return { kind: "refused", reason: "team_epoch_mismatch" };
    if (!currentLeadMatches(config, input.exactSessionId)) return { kind: "refused", reason: "lead_session_mismatch" };

    const file = hiddenObservationPath(teamName, input.teamEpochId, input.exactSessionId);
    return withLock(file, async () => {
      if (fs.existsSync(file)) {
        const previous = parseProjection(file);
        if (previous.teamEpochId !== input.teamEpochId || previous.exactSessionId !== input.exactSessionId) {
          throw new Error(`Hidden observation projection ${file} does not match its epoch/Session storage key.`);
        }
        if (previous.acknowledgedEntryId === input.acknowledgedEntryId) {
          const same = previous.teamEventCursor === input.teamEventCursor
            && JSON.stringify(previous.acknowledgedLineage) === JSON.stringify(acknowledgedLineage)
            && JSON.stringify(previous.authorityRevisions) === JSON.stringify(authorityRevisions);
          return same
            ? { kind: "committed", projection: structuredClone(previous) }
            : { kind: "refused", reason: "acknowledgement_conflict" };
        }
        if (isPrefix(acknowledgedLineage, previous.acknowledgedLineage)) {
          return { kind: "refused", reason: "stale_acknowledgement" };
        }
      }

      const projection: HiddenObservationProjection = {
        schema: HIDDEN_OBSERVATION_SCHEMA,
        teamEpochId: input.teamEpochId,
        exactSessionId: input.exactSessionId,
        acknowledgedEntryId: input.acknowledgedEntryId,
        acknowledgedLineage,
        teamEventCursor: input.teamEventCursor,
        authorityRevisions,
        updatedAt: new Date().toISOString(),
      };
      writeProjectionAtomic(file, projection);
      return { kind: "committed", projection: structuredClone(projection) };
    });
  });
}
