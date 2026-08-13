import fs from "node:fs";
import path from "node:path";
import { withLock } from "../utils/lock";
import type { TaskTeamEvent, TeamEvent, TeamEventInput, TeamEventType } from "./contracts";
import type { Member, TeamConfig } from "../team-authority/contracts";
import { isTaskTerminal, type CanonicalTaskCard } from "../task-authority/task-domain";
import { configPath, teamEventCursorStatePath, teamEventJournalPath } from "../utils/paths";
import { type TaskVersionRef } from "../task-authority/task-version-ref";

// Event/wait intent and authority boundaries: docs/current/README.md and
// docs/reference.md.

const EVENT_SCHEMA = "pi-teams-event-journal/1" as const;
const ZERO_CURSOR = "0";
export const DEFAULT_TEAM_SYNC_LIMIT = 50;
export const MAX_TEAM_SYNC_LIMIT = 100;

export interface TeamEventReadOptions {
  afterCursor?: string;
  eventTypes?: readonly TeamEventType[];
  taskIds?: readonly string[];
  limit?: number;
}

export type TaskEventEvidenceKind =
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

export interface TaskEventEvidenceInput {
  kind: TaskEventEvidenceKind;
  text: string;
}

export interface TaskEvidenceTeamEvent extends TaskTeamEvent {
  taskEvidence: TaskEventEvidenceInput;
}

export interface ProjectedTaskEventEvidence extends TaskEventEvidenceInput {
  id: string;
  at: string;
  actor: string;
}

export interface TaskActivityCoordinate {
  taskId: string;
  cursor: string;
  at: string;
}

export interface TaskActivityProjection {
  headCursor: string;
  /** One latest committed activity coordinate per Task, newest first. */
  tasks: TaskActivityCoordinate[];
}

export interface TeamEventBatch {
  /** Safe continuation position. It advances to journal head unless truncated. */
  cursor: string;
  /** Current global journal head, which can be ahead of cursor when truncated. */
  headCursor: string;
  events: TeamEvent[];
  truncated: boolean;
  /** Matching records after the returned page, not a numeric cursor gap. */
  remaining: number;
}

export interface TeamEventWaitOptions extends TeamEventReadOptions {
  teamName: string;
  waitMs?: number;
  signal?: AbortSignal;
}

export interface TeamEventWaitResult extends TeamEventBatch {
  timedOut: boolean;
}

export interface TeamTaskSummary {
  id: string;
  title: string;
  status: CanonicalTaskCard["status"];
  assignee?: string;
  version?: TaskVersionRef;
}

export interface TeamWorkerProjection {
  name: string;
  membershipId?: string;
  carrier: "prepared" | "session_bound" | "absent";
  nonterminalTasks: Array<{ id: string; status: CanonicalTaskCard["status"] }>;
}

export interface TeamCurrentProjection {
  team: {
    name: string;
    description: string;
    lifecycle: "active" | "stopped";
    taskAuthority?: { backend: "beads"; authorityId: string };
  };
  workers: TeamWorkerProjection[];
  tasks: TeamTaskSummary[];
}

export interface TeamProjectionPage {
  projection: TeamCurrentProjection;
  offset: number;
  limit: number;
  totalItems: number;
  truncated: boolean;
  continuation?: string;
}

export class TeamEventCursorAheadError extends Error {
  readonly name = "TeamEventCursorAheadError";

  constructor(
    readonly requestedCursor: string,
    readonly headCursor: string,
  ) {
    super(`Team event cursor ${requestedCursor} is ahead of journal head ${headCursor}; request a fresh snapshot instead of regressing the cursor.`);
  }
}

export class InvalidTeamSnapshotContinuationError extends Error {
  readonly name = "InvalidTeamSnapshotContinuationError";
}

function validatedLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_TEAM_SYNC_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TEAM_SYNC_LIMIT) {
    throw new Error(`limit must be an integer from 1 through ${MAX_TEAM_SYNC_LIMIT}.`);
  }
  return value;
}

function parseCursor(cursor: string | undefined): bigint {
  const value = cursor ?? ZERO_CURSOR;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Invalid Team event cursor ${JSON.stringify(value)}.`);
  }
  return BigInt(value);
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Malformed Team event: ${field} must be a nonempty string.`);
  }
}

function upgradeRequiredVersion(lineNumber: number, field: string): Error {
  const error = new Error(`Team event journal at line ${lineNumber} contains a non-canonical ${field}; run the stopped-epoch migration.`);
  error.name = "upgrade_required";
  return error;
}

function parseEvent(line: string, lineNumber: number): TeamEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Malformed Team event journal at line ${lineNumber}: expected an object.`);
  }
  const event = value as Record<string, unknown>;
  assertString(event.cursor, "cursor");
  parseCursor(event.cursor);
  assertString(event.at, "at");

  if (event.type === "task") {
    if (!event.ref || typeof event.ref !== "object" || Array.isArray(event.ref)) {
      throw new Error(`Malformed Team event journal at line ${lineNumber}: task ref is required.`);
    }
    const ref = event.ref as Record<string, unknown>;
    assertString(ref.taskId, "ref.taskId");
    assertString(ref.version, "ref.version");
    assertString(event.actor, "actor");
    if (!["created", "assigned", "goal", "note", "status", "relation"].includes(String(event.change))) {
      throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid task change.`);
    }
    if (event.taskEvidence !== undefined) {
      if (!event.taskEvidence || typeof event.taskEvidence !== "object" || Array.isArray(event.taskEvidence)) {
        throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid task evidence.`);
      }
      const evidence = event.taskEvidence as Record<string, unknown>;
      if (!["created", "goal", "assignment", "progress", "status", "relation", "decision", "blocker", "result", "note"].includes(String(evidence.kind))) {
        throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid task evidence kind.`);
      }
      assertString(evidence.text, "taskEvidence.text");
    }
  } else if (event.type === "worker") {
    assertString(event.worker, "worker");
    assertString(event.membershipId, "membershipId");
    if (!["prepared", "session_bound", "stopped", "failed"].includes(String(event.phase))) {
      throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid worker phase.`);
    }
    if (event.generation !== undefined) {
      if (event.phase !== "session_bound") throw new Error(`Malformed Team event journal at line ${lineNumber}: generation is session_bound-only.`);
      if (!event.generation || typeof event.generation !== "object" || Array.isArray(event.generation)) throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid worker generation.`);
      const generation = event.generation as Record<string, unknown>;
      assertString(generation.membershipId, "generation.membershipId");
      if (generation.membershipId !== event.membershipId || !Number.isSafeInteger(generation.pid) || Number(generation.pid) <= 1 || !Number.isSafeInteger(generation.startedAt) || Number(generation.startedAt) <= 0) throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid worker generation.`);
    }
  } else if (event.type === "alert") {
    assertString(event.alertId, "alertId");
    assertString(event.from, "from");
    assertString(event.to, "to");
    assertString(event.text, "text");
    if (!["clarification", "attention", "announcement"].includes(String(event.kind))) {
      throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid alert kind.`);
    }
    if (event.taskRef !== undefined) {
      if (!event.taskRef || typeof event.taskRef !== "object" || Array.isArray(event.taskRef)) {
        throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid alert taskRef.`);
      }
      const taskRef = event.taskRef as Record<string, unknown>;
      assertString(taskRef.taskId, "taskRef.taskId");
      if (taskRef.version !== undefined) assertString(taskRef.version, "taskRef.version");
    }
  } else {
    throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid event type.`);
  }
  if (event.type === "task") {
    const ref = event.ref as Record<string, unknown>;
    if (!/^v_[0-9a-f]{16}$/.test(ref.version as string)) throw upgradeRequiredVersion(lineNumber, "task ref version");
    return {
      ...event,
      ref: {
        taskId: ref.taskId as string,
        version: ref.version as TaskVersionRef,
      },
    } as TeamEvent;
  }
  if (event.type === "alert" && event.taskRef) {
    const taskRef = event.taskRef as Record<string, unknown>;
    return {
      ...event,
      taskRef: {
        taskId: taskRef.taskId as string,
        ...(taskRef.version !== undefined
          ? ( !/^v_[0-9a-f]{16}$/.test(taskRef.version as string)
            ? (() => { throw upgradeRequiredVersion(lineNumber, "alert task ref version"); })()
            : { version: taskRef.version as TaskVersionRef })
          : {}),
      },
    } as TeamEvent;
  }
  return value as TeamEvent;
}

function readJournal(teamName: string): TeamEvent[] {
  const journal = teamEventJournalPath(teamName);
  if (!fs.existsSync(journal)) return [];
  const raw = fs.readFileSync(journal, "utf8");
  const lines = raw.split("\n").filter((line) => line.length > 0);
  let previous = 0n;
  return lines.map((line, index) => {
    const event = parseEvent(line, index + 1);
    const cursor = parseCursor(event.cursor);
    if (cursor <= previous) {
      throw new Error(`Malformed Team event journal at line ${index + 1}: cursors must increase monotonically.`);
    }
    previous = cursor;
    return event;
  });
}

function writeCursorProjection(teamName: string, cursor: string): void {
  const target = teamEventCursorStatePath(teamName);
  const directory = path.dirname(target);
  const temp = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify({ schema: EVENT_SCHEMA, cursor, updatedAt: new Date().toISOString() }), {
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temp, target);
}

/**
 * Append one observation after its owning authority commits. The JSONL is the
 * evidence authority; cursor.json is only a rebuildable latest-position view.
 */
export async function appendTeamEvent(teamName: string, input: TeamEventInput): Promise<TeamEvent> {
  if (!fs.existsSync(configPath(teamName))) throw new Error(`Team ${teamName} not found`);
  const journal = teamEventJournalPath(teamName);
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  return withLock(journal, async () => {
    const events = readJournal(teamName);
    const cursor = ((events.length ? parseCursor(events[events.length - 1].cursor) : 0n) + 1n).toString();
    const event = { ...input, cursor, at: new Date().toISOString() } as TeamEvent;
    // Validate before committing so a structurally invalid internal caller
    // cannot poison the append-only journal.
    parseEvent(JSON.stringify(event), events.length + 1);
    const fd = fs.openSync(journal, "a", 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(event)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    writeCursorProjection(teamName, cursor);
    return event;
  });
}

/** Append structured Task evidence and return its committed identity/time. */
export async function appendTaskEvidenceEvent(
  teamName: string,
  input: Omit<TaskTeamEvent, "cursor" | "at"> & { taskEvidence: TaskEventEvidenceInput },
): Promise<TaskEvidenceTeamEvent> {
  return await appendTeamEvent(teamName, input as TeamEventInput) as TaskEvidenceTeamEvent;
}

/** Project only committed event coordinates; caller prose never supplies IDs or time. */
export function projectTaskEventEvidence(event: TeamEvent): ProjectedTaskEventEvidence | undefined {
  if (event.type !== "task" || !("taskEvidence" in event)) return undefined;
  const evidence = (event as TaskEvidenceTeamEvent).taskEvidence;
  return {
    id: `task-event-${event.cursor}`,
    at: event.at,
    actor: event.actor,
    kind: evidence.kind,
    text: evidence.text,
  };
}

/** Non-consuming read: each caller owns its supplied cursor. */
export function readTeamEvents(teamName: string, options: TeamEventReadOptions = {}): TeamEventBatch {
  const after = parseCursor(options.afterCursor);
  const events = readJournal(teamName);
  const headCursor = events.at(-1)?.cursor ?? ZERO_CURSOR;
  if (after > parseCursor(headCursor)) {
    throw new TeamEventCursorAheadError(options.afterCursor!, headCursor);
  }
  const types = options.eventTypes ? new Set(options.eventTypes) : undefined;
  const taskIds = options.taskIds ? new Set(options.taskIds) : undefined;
  const limit = validatedLimit(options.limit);
  const matching = events.filter((event) => {
    if (parseCursor(event.cursor) <= after || (types && !types.has(event.type))) return false;
    if (!taskIds) return true;
    if (event.type === "task") return taskIds.has(event.ref.taskId);
    if (event.type === "alert") return !!event.taskRef && taskIds.has(event.taskRef.taskId);
    // A Task-targeted sync must not let unrelated Worker telemetry crowd the
    // requested semantic changes out of a bounded page.
    return false;
  });
  const selected = matching.slice(0, limit);
  const remaining = matching.length - selected.length;
  const truncated = remaining > 0;
  return {
    cursor: truncated ? selected.at(-1)!.cursor : headCursor,
    headCursor,
    events: selected,
    truncated,
    remaining,
  };
}

export function readTeamEventCursor(teamName: string): string {
  return readJournal(teamName).at(-1)?.cursor ?? ZERO_CURSOR;
}

/**
 * Read the journal once and project only latest per-Task activity coordinates.
 * This is ordering evidence for derived views, not Task state authority.
 */
export function readTaskActivity(teamName: string): TaskActivityProjection {
  const events = readJournal(teamName);
  const latest = new Map<string, TaskActivityCoordinate>();
  for (const event of events) {
    if (event.type !== "task") continue;
    latest.set(event.ref.taskId, { taskId: event.ref.taskId, cursor: event.cursor, at: event.at });
  }
  return {
    headCursor: events.at(-1)?.cursor ?? ZERO_CURSOR,
    tasks: [...latest.values()].sort((a, b) => {
      const left = parseCursor(a.cursor);
      const right = parseCursor(b.cursor);
      return right > left ? 1 : right < left ? -1 : a.taskId.localeCompare(b.taskId);
    }),
  };
}

function abortError(): Error {
  const error = new Error("Team event wait aborted");
  error.name = "AbortError";
  return error;
}

/** Event-driven check-register-check wait; filesystem notifications are hints. */
export async function waitForTeamEvents(options: TeamEventWaitOptions): Promise<TeamEventWaitResult> {
  const waitMs = options.waitMs ?? 0;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error("waitMs must be a nonnegative finite number.");
  if (options.signal?.aborted) throw abortError();

  const read = () => readTeamEvents(options.teamName, options);
  const initial = read();
  if (initial.events.length > 0 || waitMs === 0) return { ...initial, timedOut: false };

  const journal = teamEventJournalPath(options.teamName);
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  return new Promise<TeamEventWaitResult>((resolve, reject) => {
    let settled = false;
    let scanning = false;
    let rescan = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };
    const scan = () => {
      if (settled) return;
      if (scanning) {
        rescan = true;
        return;
      }
      scanning = true;
      try {
        const batch = read();
        if (batch.events.length > 0) finish(() => resolve({ ...batch, timedOut: false }));
      } catch (error) {
        finish(() => reject(error));
      } finally {
        scanning = false;
        if (rescan && !settled) {
          rescan = false;
          queueMicrotask(scan);
        }
      }
    };
    const onAbort = () => finish(() => reject(abortError()));
    const watcher = fs.watch(path.dirname(journal), (_event, filename) => {
      if (!filename || filename.toString() === path.basename(journal)) scan();
    });
    watcher.on("error", (error) => finish(() => reject(error)));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      try {
        const batch = read();
        finish(() => resolve({ ...batch, timedOut: true }));
      } catch (error) {
        finish(() => reject(error));
      }
    }, waitMs);
    timer.unref?.();
    // Close the lost-wakeup gap between the first read and watcher creation.
    scan();
  });
}

/** Snapshot mode returns the current cursor without replaying history. */
export async function syncTeamEvents(options: TeamEventWaitOptions & { cursor?: string }): Promise<TeamEventWaitResult> {
  if (options.cursor === undefined) {
    const cursor = readTeamEventCursor(options.teamName);
    return { cursor, headCursor: cursor, events: [], truncated: false, remaining: 0, timedOut: false };
  }
  return waitForTeamEvents({ ...options, afterCursor: options.cursor });
}

function latestWorkerMemberships(members: readonly Member[]): Map<string, Member> {
  const latest = new Map<string, Member>();
  for (const member of members) {
    if (member.agentType === "teammate") latest.set(member.name, member);
  }
  return latest;
}

/**
 * Build the compact current projection from authoritative records already read
 * by the caller. This stays pure so the event journal never imports the Task
 * adapter and Task mutations can append events without a dependency cycle.
 */
export function projectTeamCurrentState(config: TeamConfig, tasks: ReadonlyArray<CanonicalTaskCard>): TeamCurrentProjection {
  const taskSummaries: TeamTaskSummary[] = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    ...(task.version ? { version: task.version as TaskVersionRef } : {}),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const workers = [...latestWorkerMemberships(config.members).values()].map((member): TeamWorkerProjection => {
    const current = member.isActive !== false;
    return {
      name: member.name,
      ...(current && member.membershipId ? { membershipId: member.membershipId } : {}),
      carrier: current ? (member.sessionFile ? "session_bound" : "prepared") : "absent",
      nonterminalTasks: tasks
        .filter((task) => task.assignee === member.name && !isTaskTerminal(task))
        .map((task) => ({ id: task.id, status: task.status })),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const lifecycle = config.members.some((member) => member.isActive !== false) ? "active" : "stopped";
  return {
    team: {
      name: config.name,
      description: config.description,
      lifecycle,
      ...(config.taskBackend === "beads" && config.taskAuthorityId
        ? { taskAuthority: { backend: "beads" as const, authorityId: config.taskAuthorityId } }
        : {}),
    },
    workers,
    tasks: taskSummaries,
  };
}

interface SnapshotContinuationPayload {
  schema: "pi-teams-snapshot-page/1";
  teamName: string;
  headCursor: string;
  offset: number;
}

function encodeSnapshotContinuation(payload: SnapshotContinuationPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeSnapshotContinuation(token: string, teamName: string, headCursor: string): SnapshotContinuationPayload {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new InvalidTeamSnapshotContinuationError("Snapshot continuation is malformed; request a fresh snapshot.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidTeamSnapshotContinuationError("Snapshot continuation is malformed; request a fresh snapshot.");
  }
  const payload = value as Partial<SnapshotContinuationPayload>;
  if (
    payload.schema !== "pi-teams-snapshot-page/1"
    || payload.teamName !== teamName
    || payload.headCursor !== headCursor
    || !Number.isSafeInteger(payload.offset)
    || payload.offset! < 0
  ) {
    throw new InvalidTeamSnapshotContinuationError(
      payload.headCursor !== undefined && payload.headCursor !== headCursor
        ? `Snapshot continuation was issued at cursor ${payload.headCursor}, but journal head is now ${headCursor}; request a fresh snapshot.`
        : "Snapshot continuation does not match this Team; request a fresh snapshot.",
    );
  }
  return payload as SnapshotContinuationPayload;
}

/** Bound a compact snapshot and return an opaque continuation pinned to its event head. */
export function pageTeamCurrentProjection(
  projection: TeamCurrentProjection,
  options: { headCursor: string; limit?: number; continuation?: string },
): TeamProjectionPage {
  const limit = validatedLimit(options.limit);
  const offset = options.continuation
    ? decodeSnapshotContinuation(options.continuation, projection.team.name, options.headCursor).offset
    : 0;
  const records = [
    ...projection.workers.map((worker) => ({ kind: "worker" as const, worker })),
    ...projection.tasks.map((task) => ({ kind: "task" as const, task })),
  ];
  if (offset > records.length) {
    throw new InvalidTeamSnapshotContinuationError("Snapshot continuation is beyond the current projection; request a fresh snapshot.");
  }
  const page = records.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const truncated = nextOffset < records.length;
  return {
    projection: {
      team: projection.team,
      workers: page.flatMap((record) => record.kind === "worker" ? [record.worker] : []),
      tasks: page.flatMap((record) => record.kind === "task" ? [record.task] : []),
    },
    offset,
    limit,
    totalItems: records.length,
    truncated,
    ...(truncated ? {
      continuation: encodeSnapshotContinuation({
        schema: "pi-teams-snapshot-page/1",
        teamName: projection.team.name,
        headCursor: options.headCursor,
        offset: nextOffset,
      }),
    } : {}),
  };
}

/** Hydrate changed/requested Task references from their current authority state. */
export async function hydrateTeamSyncTasks(
  events: readonly TeamEvent[],
  requestedTaskIds: readonly string[] | undefined,
  readTasks: (taskIds: readonly string[]) => Promise<CanonicalTaskCard[]>,
): Promise<CanonicalTaskCard[]> {
  const ids = new Set(requestedTaskIds ?? []);
  for (const event of events) {
    if (event.type === "task") ids.add(event.ref.taskId);
    if (event.type === "alert" && event.taskRef) ids.add(event.taskRef.taskId);
  }
  return readTasks([...ids]);
}
