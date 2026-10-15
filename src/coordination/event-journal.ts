import { hostEnv, type TimerHandle } from "../env/host-env";
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
  /** First committed Task event observed in this Team journal. */
  firstActivityAt: string;
  /** Latest committed Task event observed in this Team journal. */
  lastActivityAt: string;
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
    if (!["prepared", "session_bound", "stopped", "failed", "carrier"].includes(String(event.phase))) {
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

interface JournalReadCache {
  device: number;
  inode: number;
  byteOffset: number;
  modifiedAt: number;
  changedAt: number;
  endsWithNewline: boolean;
  events: TeamEvent[];
  lastCursor: bigint;
}

const JOURNAL_READ_CACHE_LIMIT = 32;
const journalReadCache = new Map<string, JournalReadCache>();

function cacheJournalRead(journal: string, cache: JournalReadCache): void {
  journalReadCache.delete(journal);
  journalReadCache.set(journal, cache);
  while (journalReadCache.size > JOURNAL_READ_CACHE_LIMIT) {
    journalReadCache.delete(journalReadCache.keys().next().value!);
  }
}

function parseJournalLines(raw: string, priorEvents: readonly TeamEvent[] = [], priorCursor?: bigint): TeamEvent[] {
  const events = [...priorEvents];
  let previous = priorCursor ?? (events.length ? parseCursor(events.at(-1)!.cursor) : 0n);
  const lines = raw.split("\n").filter((line) => line.length > 0);
  for (const line of lines) {
    const event = parseEvent(line, events.length + 1);
    const cursor = parseCursor(event.cursor);
    if (cursor <= previous) {
      throw new Error(`Malformed Team event journal at line ${events.length + 1}: cursors must increase monotonically.`);
    }
    previous = cursor;
    events.push(event);
  }
  return events;
}

function readRange(fd: number, start: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, bytes, offset, length - offset, start + offset);
    if (count === 0) throw new Error("Team event journal changed while it was being read.");
    offset += count;
  }
  return bytes;
}

/** Read and validate new journal bytes once, then reuse the parsed image by cursor. */
function readJournal(teamName: string): TeamEvent[] {
  const journal = teamEventJournalPath(teamName);
  if (!fs.existsSync(journal)) {
    journalReadCache.delete(journal);
    return [];
  }
  const fd = fs.openSync(journal, "r");
  try {
    const stat = fs.fstatSync(fd);
    const cached = journalReadCache.get(journal);
    if (cached) cacheJournalRead(journal, cached);
    const sameFile = !!cached && cached.device === stat.dev && cached.inode === stat.ino;
    if (cached && sameFile && stat.size >= cached.byteOffset) {
      if (stat.size === cached.byteOffset && stat.mtimeMs === cached.modifiedAt && stat.ctimeMs === cached.changedAt) return cached.events;
      if (stat.size > cached.byteOffset && cached.endsWithNewline) {
        try {
          const appended = readRange(fd, cached.byteOffset, stat.size - cached.byteOffset);
          const events = parseJournalLines(appended.toString("utf8"), cached.events, cached.lastCursor);
          const tail = appended.at(-1) ?? 0;
          const result: JournalReadCache = {
            device: stat.dev,
            inode: stat.ino,
            byteOffset: stat.size,
            modifiedAt: stat.mtimeMs,
            changedAt: stat.ctimeMs,
            endsWithNewline: tail === 10,
            events,
            lastCursor: events.length ? parseCursor(events.at(-1)!.cursor) : 0n,
          };
          cacheJournalRead(journal, result);
          return events;
        } catch (error) {
          journalReadCache.delete(journal);
          throw error;
        }
      }
      // Same-size rewrites and appends after a valid unterminated event are
      // ambiguous. Revalidate the complete image rather than extending cache.
    }

    try {
      const raw = readRange(fd, 0, stat.size);
      const events = parseJournalLines(raw.toString("utf8"));
      cacheJournalRead(journal, {
        device: stat.dev,
        inode: stat.ino,
        byteOffset: stat.size,
        modifiedAt: stat.mtimeMs,
        changedAt: stat.ctimeMs,
        endsWithNewline: stat.size === 0 || raw.at(-1) === 10,
        events,
        lastCursor: events.length ? parseCursor(events.at(-1)!.cursor) : 0n,
      });
      return events;
    } catch (error) {
      journalReadCache.delete(journal);
      throw error;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readJournalTailCursor(teamName: string): bigint {
  const journal = teamEventJournalPath(teamName);
  if (!fs.existsSync(journal)) return 0n;
  const fd = fs.openSync(journal, "r+");
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return 0n;
    const chunkSize = 4096;
    let end = size;
    let bytes = Buffer.alloc(0);
    let newlineCount = 0;
    while (end > 0 && newlineCount < 2) {
      const start = Math.max(0, end - chunkSize);
      const chunk = Buffer.alloc(end - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      bytes = Buffer.concat([chunk, bytes]);
      newlineCount = [...bytes].filter((byte) => byte === 10).length;
      end = start;
    }
    const complete = bytes.at(-1) === 10;
    const lines = bytes.toString("utf8").split("\n");
    const finalLine = complete ? lines.at(-2) ?? "" : lines.at(-1) ?? "";
    if (!finalLine) return 0n;
    try {
      const event = parseEvent(finalLine, 0);
      if (!complete) fs.writeSync(fd, Buffer.from("\n"), 0, 1, size);
      return parseCursor(event.cursor);
    } catch (error) {
      if (complete) throw error;
      // A malformed unterminated suffix is a torn write. Drop only that suffix.
      const priorLine = lines.at(-2) ?? "";
      const truncateAt = size - Buffer.byteLength(finalLine);
      fs.ftruncateSync(fd, Math.max(0, truncateAt));
      if (!priorLine) return 0n;
      return parseCursor(parseEvent(priorLine, 0).cursor);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function writeCursorProjection(teamName: string, cursor: string): void {
  const target = teamEventCursorStatePath(teamName);
  const directory = path.dirname(target);
  const temp = path.join(directory, `.${path.basename(target)}.${hostEnv().process.pid}.${hostEnv().clock.now()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify({ schema: EVENT_SCHEMA, cursor, updatedAt: new Date(hostEnv().clock.now()).toISOString() }), {
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temp, target);
}

/**
 * Append one observation after its owning authority commits. The JSONL is the
 * evidence authority; cursor.json is only a rebuildable latest-position view.
 */
export async function appendTeamEvents(teamName: string, inputs: readonly TeamEventInput[]): Promise<TeamEvent[]> {
  if (!inputs.length) return [];
  if (!fs.existsSync(configPath(teamName))) throw new Error(`Team ${teamName} not found`);
  const journal = teamEventJournalPath(teamName);
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  return withLock(journal, async () => {
    let cursor = readJournalTailCursor(teamName);
    const events = inputs.map((input) => {
      cursor += 1n;
      const event = { ...input, cursor: cursor.toString(), at: new Date(hostEnv().clock.now()).toISOString() } as TeamEvent;
      // Validate every record before writing any part of the batch.
      parseEvent(JSON.stringify(event), 0);
      return event;
    });
    const fd = fs.openSync(journal, "a", 0o600);
    try {
      fs.writeSync(fd, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    writeCursorProjection(teamName, cursor.toString());
    return events;
  });
}

export async function appendTeamEvent(teamName: string, input: TeamEventInput): Promise<TeamEvent> {
  return (await appendTeamEvents(teamName, [input]))[0];
}

/** Append structured Task evidence as one durable journal batch. */
export async function appendTaskEvidenceEvents(
  teamName: string,
  inputs: readonly (Omit<TaskTeamEvent, "cursor" | "at"> & { taskEvidence: TaskEventEvidenceInput })[],
): Promise<TaskEvidenceTeamEvent[]> {
  return await appendTeamEvents(teamName, inputs as readonly TeamEventInput[]) as TaskEvidenceTeamEvent[];
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

function firstEventAfter(events: readonly TeamEvent[], cursor: bigint): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (parseCursor(events[middle].cursor) <= cursor) low = middle + 1;
    else high = middle;
  }
  return low;
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
  const start = firstEventAfter(events, after);
  const matching = !types && !taskIds
    ? events.slice(start, start + limit)
    : events.slice(start).filter((event) => {
      if (types && !types.has(event.type)) return false;
      if (!taskIds) return true;
      if (event.type === "task") return taskIds.has(event.ref.taskId);
      if (event.type === "alert") return !!event.taskRef && taskIds.has(event.taskRef.taskId);
      // A Task-targeted sync must not let unrelated Worker telemetry crowd the
      // requested semantic changes out of a bounded page.
      return false;
    }).slice(0, limit);
  const matchingCount = !types && !taskIds
    ? events.length - start
    : events.slice(start).filter((event) => {
      if (types && !types.has(event.type)) return false;
      if (!taskIds) return true;
      if (event.type === "task") return taskIds.has(event.ref.taskId);
      if (event.type === "alert") return !!event.taskRef && taskIds.has(event.taskRef.taskId);
      return false;
    }).length;
  const remaining = matchingCount - matching.length;
  const truncated = remaining > 0;
  return {
    cursor: truncated ? matching.at(-1)!.cursor : headCursor,
    headCursor,
    events: matching,
    truncated,
    remaining,
  };
}

/** Read one journal image and split unseen events into bounded observation pages. */
export function readTeamEventPages(teamName: string, options: Pick<TeamEventReadOptions, "afterCursor" | "limit"> = {}): TeamEventBatch[] {
  const after = parseCursor(options.afterCursor);
  const events = readJournal(teamName);
  const headCursor = events.at(-1)?.cursor ?? ZERO_CURSOR;
  if (after > parseCursor(headCursor)) {
    throw new TeamEventCursorAheadError(options.afterCursor!, headCursor);
  }
  const limit = validatedLimit(options.limit);
  const unseen = events.filter((event) => parseCursor(event.cursor) > after);
  if (unseen.length === 0) {
    return [{ events: [], cursor: headCursor, headCursor, truncated: false, remaining: 0 }];
  }
  const pages: TeamEventBatch[] = [];
  for (let offset = 0; offset < unseen.length; offset += limit) {
    const selected = unseen.slice(offset, offset + limit);
    const remaining = unseen.length - offset - selected.length;
    pages.push({
      events: selected,
      cursor: remaining > 0 ? selected.at(-1)!.cursor : headCursor,
      headCursor,
      truncated: remaining > 0,
      remaining,
    });
  }
  return pages;
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
  const activity = new Map<string, TaskActivityCoordinate>();
  for (const event of events) {
    if (event.type !== "task") continue;
    const prior = activity.get(event.ref.taskId);
    activity.set(event.ref.taskId, {
      taskId: event.ref.taskId,
      cursor: event.cursor,
      firstActivityAt: prior?.firstActivityAt ?? event.at,
      lastActivityAt: event.at,
    });
  }
  return {
    headCursor: events.at(-1)?.cursor ?? ZERO_CURSOR,
    tasks: [...activity.values()].sort((a, b) => {
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
  const clock = hostEnv().clock;
  return new Promise<TeamEventWaitResult>((resolve, reject) => {
    let settled = false;
    let scanning = false;
    let rescan = false;
    let timer: TimerHandle;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
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
    const watcher = hostEnv().watch.watchDirectory(path.dirname(journal), (filename) => {
      if (!filename || filename.toString() === path.basename(journal)) scan();
    });
    watcher.onError((error) => finish(() => reject(error)));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = clock.setTimeout(() => {
      try {
        const batch = read();
        finish(() => resolve({ ...batch, timedOut: true }));
      } catch (error) {
        finish(() => reject(error));
      }
    }, waitMs);
    if ("unref" in timer) timer.unref();
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
