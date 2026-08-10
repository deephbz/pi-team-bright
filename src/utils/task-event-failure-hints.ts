import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock";
import { taskEventFailureHintPath } from "./paths";
import type { TaskVersionRef } from "../task-authority/task-version-ref";

export const TASK_EVENT_FAILURE_HINT_SCHEMA = "pi-teams-task-event-failure-hint/1" as const;

type HintCoordinates = {
  teamEpochId: string;
  taskId: string;
  taskVersion: TaskVersionRef;
  actor: string;
  at: string;
};

/** A newly written hint always has a Team-epoch-local cursor. */
export type TaskEventFailureHint = HintCoordinates & {
  schema: typeof TASK_EVENT_FAILURE_HINT_SCHEMA;
  cursor: string;
};

/** Historical records may predate cursor assignment. */
export type TaskEventFailureHintRecord = Omit<TaskEventFailureHint, "cursor"> & { cursor?: string };

export type TaskEventFailureHintActorKind = "team-lead" | "non-leader/external";

export type TaskEventFailureHintMatch = {
  hint: TaskEventFailureHintRecord;
  actorKind: TaskEventFailureHintActorKind;
};

export type CurrentTaskEventReference = {
  taskId: string;
  taskVersion: TaskVersionRef;
};

export type TaskEventFailureHintBatch = {
  cursor: string;
  headCursor: string;
  hints: TaskEventFailureHintMatch[];
};

export class TaskEventFailureHintCursorAheadError extends Error {
  readonly name = "TaskEventFailureHintCursorAheadError";
  constructor(readonly requestedCursor: string, readonly headCursor: string) {
    super(`Task event failure hint cursor ${requestedCursor} is ahead of head ${headCursor}.`);
  }
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validCursor(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function validHint(value: unknown): value is TaskEventFailureHintRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hint = value as Partial<TaskEventFailureHintRecord>;
  const allowedKeys = new Set(["schema", "teamEpochId", "taskId", "taskVersion", "actor", "at", "cursor"]);
  if (Object.keys(hint).some((key) => !allowedKeys.has(key))) return false;
  return hint.schema === TASK_EVENT_FAILURE_HINT_SCHEMA
    && validString(hint.teamEpochId)
    && validString(hint.taskId)
    && typeof hint.taskVersion === "string"
    && /^v_[0-9a-f]{16}$/.test(hint.taskVersion)
    && validString(hint.actor)
    && validString(hint.at)
    && !Number.isNaN(Date.parse(hint.at))
    && (hint.cursor === undefined || validCursor(hint.cursor));
}

function readLines(file: string): TaskEventFailureHintRecord[] {
  if (!fs.existsSync(file)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const hints: TaskEventFailureHintRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (validHint(value)) hints.push(value);
    } catch {
      // A malformed derived record cannot become Task or event meaning.
    }
  }
  return hints;
}

function assertHint(input: HintCoordinates): void {
  if (!validHint({ schema: TASK_EVENT_FAILURE_HINT_SCHEMA, ...input, cursor: "1" })) {
    throw new Error("Task event failure hint is malformed.");
  }
}

function parseCursor(value: string): bigint {
  if (!validCursor(value)) throw new Error(`Invalid Task event failure hint cursor ${JSON.stringify(value)}.`);
  return BigInt(value);
}

function currentEpochHead(hints: readonly TaskEventFailureHintRecord[], teamEpochId: string): bigint {
  return hints.reduce((head, hint) => {
    if (hint.teamEpochId !== teamEpochId || hint.cursor === undefined) return head;
    return head > BigInt(hint.cursor) ? head : BigInt(hint.cursor);
  }, 0n);
}

/** Append payload-light derived evidence without entering the Team event journal. */
export async function appendTaskEventFailureHint(
  teamName: string,
  input: HintCoordinates,
): Promise<TaskEventFailureHint> {
  assertHint(input);
  const file = taskEventFailureHintPath(teamName);
  let hint!: TaskEventFailureHint;
  await withLock(`${file}.lock`, async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const cursor = (currentEpochHead(readLines(file), input.teamEpochId) + 1n).toString();
    hint = { schema: TASK_EVENT_FAILURE_HINT_SCHEMA, ...input, cursor };
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(hint)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(file, 0o600);
  });
  return hint;
}

/** Read only structurally valid hints. Authority and current Task matching is separate. */
export function readTaskEventFailureHintRecords(teamName: string): TaskEventFailureHintRecord[] {
  return readLines(taskEventFailureHintPath(teamName));
}

function matchingHints(
  teamName: string,
  options: { teamEpochId: string; taskReferences: readonly CurrentTaskEventReference[] },
): TaskEventFailureHintMatch[] {
  const current = new Map(options.taskReferences.map((reference) => [reference.taskId, reference.taskVersion]));
  return readTaskEventFailureHintRecords(teamName)
    .filter((hint) => hint.teamEpochId === options.teamEpochId && current.get(hint.taskId) === hint.taskVersion)
    .map((hint) => ({
      hint,
      actorKind: hint.actor === "team-lead" ? "team-lead" : "non-leader/external",
    }));
}

/** Match hints to one acknowledged projection's current Team epoch and Task references. */
export function readTaskEventFailureHints(
  teamName: string,
  options: { teamEpochId: string; taskReferences: readonly CurrentTaskEventReference[] },
): TaskEventFailureHintMatch[] {
  return matchingHints(teamName, options);
}

/** Read matching valid hints after a caller's acknowledged hint cursor. */
export function readTaskEventFailureHintsAfter(
  teamName: string,
  afterCursor: string,
  options: { teamEpochId: string; taskReferences: readonly CurrentTaskEventReference[] },
): TaskEventFailureHintBatch {
  const after = parseCursor(afterCursor);
  const records = readTaskEventFailureHintRecords(teamName);
  const head = currentEpochHead(records, options.teamEpochId);
  if (after > head) throw new TaskEventFailureHintCursorAheadError(afterCursor, head.toString());
  const matches = matchingHints(teamName, options).filter((match) => match.hint.cursor !== undefined && BigInt(match.hint.cursor) > after);
  return { cursor: head.toString(), headCursor: head.toString(), hints: matches };
}
