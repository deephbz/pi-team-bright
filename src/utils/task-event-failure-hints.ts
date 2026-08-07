import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock";
import { taskEventFailureHintPath } from "./paths";
import type { TaskVersionRef } from "../model-tool-contract/task-version-ref";

export const TASK_EVENT_FAILURE_HINT_SCHEMA = "pi-teams-task-event-failure-hint/1" as const;

export type TaskEventFailureHint = {
  schema: typeof TASK_EVENT_FAILURE_HINT_SCHEMA;
  teamEpochId: string;
  taskId: string;
  taskVersion: TaskVersionRef;
  actor: string;
  at: string;
};

export type TaskEventFailureHintActorKind = "team-lead" | "non-leader/external";

export type TaskEventFailureHintMatch = {
  hint: TaskEventFailureHint;
  actorKind: TaskEventFailureHintActorKind;
};

export type CurrentTaskEventReference = {
  taskId: string;
  taskVersion: TaskVersionRef;
};

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validHint(value: unknown): value is TaskEventFailureHint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hint = value as Partial<TaskEventFailureHint>;
  return hint.schema === TASK_EVENT_FAILURE_HINT_SCHEMA
    && validString(hint.teamEpochId)
    && validString(hint.taskId)
    && typeof hint.taskVersion === "string"
    && /^v_[0-9a-f]{16}$/.test(hint.taskVersion)
    && validString(hint.actor)
    && validString(hint.at)
    && !Number.isNaN(Date.parse(hint.at));
}

function readLines(file: string): TaskEventFailureHint[] {
  if (!fs.existsSync(file)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const hints: TaskEventFailureHint[] = [];
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

function assertHint(input: Omit<TaskEventFailureHint, "schema">): void {
  if (!validHint({ schema: TASK_EVENT_FAILURE_HINT_SCHEMA, ...input })) {
    throw new Error("Task event failure hint is malformed.");
  }
}

/** Append payload-light derived evidence without entering the Team event journal. */
export async function appendTaskEventFailureHint(
  teamName: string,
  input: Omit<TaskEventFailureHint, "schema">,
): Promise<TaskEventFailureHint> {
  assertHint(input);
  const hint: TaskEventFailureHint = { schema: TASK_EVENT_FAILURE_HINT_SCHEMA, ...input };
  const file = taskEventFailureHintPath(teamName);
  await withLock(`${file}.lock`, async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
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
export function readTaskEventFailureHintRecords(teamName: string): TaskEventFailureHint[] {
  return readLines(taskEventFailureHintPath(teamName));
}

/** Match hints to one acknowledged projection's current Team epoch and Task references. */
export function readTaskEventFailureHints(
  teamName: string,
  options: {
    teamEpochId: string;
    taskReferences: readonly CurrentTaskEventReference[];
  },
): TaskEventFailureHintMatch[] {
  const current = new Map(options.taskReferences.map((reference) => [reference.taskId, reference.taskVersion]));
  return readTaskEventFailureHintRecords(teamName)
    .filter((hint) => hint.teamEpochId === options.teamEpochId && current.get(hint.taskId) === hint.taskVersion)
    .map((hint) => ({
      hint,
      actorKind: hint.actor === "team-lead" ? "team-lead" : "non-leader/external",
    }));
}
