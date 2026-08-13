import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-json";
import { withLock } from "./lock";
import { graphRevisionRetirementPath } from "./paths";
import type {
  GraphRevisionRetirementInput,
  GraphTaskCoordinate,
} from "../task-authority/graph-revision-retirement";
import type { GraphVersionRef } from "../task-authority/graph-control";
import type { TaskVersionRef } from "../task-authority/task-version-ref";

export interface GraphRevisionRetirementRecord {
  graphVersion: GraphVersionRef;
  graphSequence: number;
  authoritySequence: number;
  operationId: string;
  currentTasks: GraphTaskCoordinate[];
  retiredTasks: GraphTaskCoordinate[];
  recordedAt: string;
}

export interface GraphRevisionRetirementSnapshot {
  schema: "pi-team-bright-graph-revision-retirement/2";
  teamName: string;
  current: GraphRevisionRetirementRecord;
  history: GraphRevisionRetirementRecord[];
}

function coordinateKey(coordinate: GraphTaskCoordinate): string {
  return `${coordinate.taskId}\u0000${coordinate.taskVersion}`;
}

function sortedUnique(values: readonly GraphTaskCoordinate[]): GraphTaskCoordinate[] {
  return [...new Map(values.map((value) => [coordinateKey(value), {
    taskId: value.taskId,
    taskVersion: value.taskVersion,
  }])).values()].sort((left, right) => coordinateKey(left).localeCompare(coordinateKey(right)));
}

function graphOperationSemantics(record: GraphRevisionRetirementRecord): string {
  return JSON.stringify({
    graphVersion: record.graphVersion,
    graphSequence: record.graphSequence,
    operationId: record.operationId,
  });
}

function currentnessSemantics(record: GraphRevisionRetirementRecord): string {
  return JSON.stringify({
    graphVersion: record.graphVersion,
    graphSequence: record.graphSequence,
    authoritySequence: record.authoritySequence,
    currentTasks: record.currentTasks,
  });
}

function isTaskVersionRef(value: unknown): value is TaskVersionRef {
  return typeof value === "string" && /^v_[0-9a-f]{16}$/.test(value);
}

function validateCoordinate(value: unknown): value is GraphTaskCoordinate {
  if (!value || typeof value !== "object") return false;
  const coordinate = value as Partial<GraphTaskCoordinate>;
  return typeof coordinate.taskId === "string"
    && !!coordinate.taskId
    && isTaskVersionRef(coordinate.taskVersion);
}

function validateRecord(value: unknown): value is GraphRevisionRetirementRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<GraphRevisionRetirementRecord>;
  return typeof record.graphVersion === "string"
    && /^g_[0-9a-f]+$/.test(record.graphVersion)
    && Number.isSafeInteger(record.graphSequence)
    && (record.graphSequence ?? 0) > 0
    && Number.isSafeInteger(record.authoritySequence)
    && (record.authoritySequence ?? 0) >= (record.graphSequence ?? 0)
    && typeof record.operationId === "string"
    && !!record.operationId
    && Array.isArray(record.currentTasks)
    && record.currentTasks.every(validateCoordinate)
    && Array.isArray(record.retiredTasks)
    && record.retiredTasks.every(validateCoordinate)
    && typeof record.recordedAt === "string";
}

function readUnsafe(file: string): GraphRevisionRetirementSnapshot | undefined {
  if (!fs.existsSync(file)) return undefined;
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<GraphRevisionRetirementSnapshot> & { schema?: string };
  if (
    value.schema !== "pi-team-bright-graph-revision-retirement/2"
    || typeof value.teamName !== "string"
    || !validateRecord(value.current)
    || !Array.isArray(value.history)
    || !value.history.every(validateRecord)
  ) throw new Error(`Graph revision retirement at ${file} requires exact Task-version repair by replaying the current graph revision.`);
  return value as GraphRevisionRetirementSnapshot;
}

/** Read while the caller owns the graph-revision retirement lock. */
export function readGraphRevisionRetirementLocked(teamName: string): GraphRevisionRetirementSnapshot | undefined {
  return readUnsafe(graphRevisionRetirementPath(teamName));
}

/** Read the latest durable complete-graph fence. */
export async function readGraphRevisionRetirement(teamName: string): Promise<GraphRevisionRetirementSnapshot | undefined> {
  const file = graphRevisionRetirementPath(teamName);
  if (!fs.existsSync(file)) return undefined;
  return withLock(file, async () => readGraphRevisionRetirementLocked(teamName));
}

/**
 * Persist a monotonic complete-graph fence.
 *
 * Replaying the same operation is idempotent. A stale replay never regresses
 * the current fence. Reusing an operation ID with different semantics refuses.
 */
export async function recordGraphRevisionRetirement(input: GraphRevisionRetirementInput): Promise<GraphRevisionRetirementSnapshot> {
  const file = graphRevisionRetirementPath(input.teamName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, async () => recordGraphRevisionRetirementLocked(input));
}

/** Same mutation while the caller owns the graph-revision retirement lock. */
export function recordGraphRevisionRetirementLocked(input: GraphRevisionRetirementInput): GraphRevisionRetirementSnapshot {
  const file = graphRevisionRetirementPath(input.teamName);
  let prior: GraphRevisionRetirementSnapshot | undefined;
  try {
    prior = readUnsafe(file);
  } catch (error) {
    const legacy = JSON.parse(fs.readFileSync(file, "utf8")) as {
      schema?: string;
      current?: { graphSequence?: number; operationId?: string };
    };
    if (legacy.schema !== "pi-team-bright-graph-revision-retirement/1") throw error;
    const legacySequence = legacy.current?.graphSequence;
    if (!Number.isSafeInteger(legacySequence)
      || legacySequence! !== input.graphSequence
      || legacy.current?.operationId !== input.operationId) {
      throw new Error(`Graph revision retirement at ${file} requires replay of its exact current graph operation before exact Task-version currentness is available.`);
    }
    // The matching complete graph replay is the only safe recovery authority
    // for an ID-only fence. It starts exact history without inventing versions.
    prior = undefined;
  }
  const candidate: GraphRevisionRetirementRecord = {
    graphVersion: input.graphVersion,
    graphSequence: input.graphSequence,
    authoritySequence: input.authoritySequence,
    operationId: input.operationId,
    currentTasks: sortedUnique(input.currentTasks),
    retiredTasks: sortedUnique(input.retiredTasks),
    recordedAt: new Date().toISOString(),
  };
  const priorOperation = prior?.history.find((record) => record.operationId === input.operationId);
  if (priorOperation && graphOperationSemantics(priorOperation) !== graphOperationSemantics(candidate)) {
    throw new Error(`Graph retirement operation ${input.operationId} conflicts with durable replacement evidence.`);
  }
  if (prior?.current.authoritySequence && input.authoritySequence < prior.current.authoritySequence) return prior;
  if (prior?.current.authoritySequence === input.authoritySequence
    && currentnessSemantics(prior.current) !== currentnessSemantics(candidate)) {
    throw new Error(`Graph authority sequence ${input.authoritySequence} conflicts with the current retirement fence.`);
  }
  if (prior?.current.authoritySequence === input.authoritySequence) return prior;
  const history = priorOperation ? prior!.history : [...(prior?.history ?? []), candidate];
  const snapshot: GraphRevisionRetirementSnapshot = {
    schema: "pi-team-bright-graph-revision-retirement/2",
    teamName: input.teamName,
    current: prior?.current.authoritySequence && prior.current.authoritySequence > input.authoritySequence
      ? prior.current
      : candidate,
    history,
  };
  writeJsonAtomic(file, snapshot);
  return snapshot;
}

/** Exact current graph coordinate while the caller owns the retirement lock. */
export function taskIsCurrentInGraphLocked(teamName: string, taskId: string, taskVersion: TaskVersionRef): boolean {
  const snapshot = readGraphRevisionRetirementLocked(teamName);
  return !snapshot || snapshot.current.currentTasks.some((coordinate) =>
    coordinate.taskId === taskId && coordinate.taskVersion === taskVersion);
}

/** Exact current graph coordinate. No fence means the legacy path is unrestricted. */
export async function taskIsCurrentInGraph(teamName: string, taskId: string, taskVersion: TaskVersionRef): Promise<boolean> {
  const file = graphRevisionRetirementPath(teamName);
  if (!fs.existsSync(file)) return true;
  return withLock(file, async () => taskIsCurrentInGraphLocked(teamName, taskId, taskVersion));
}
