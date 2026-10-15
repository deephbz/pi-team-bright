import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { GraphControlRefusal, GraphTaskController, GraphSnapshotValidator, type GraphControlSnapshot } from "../task-authority/graph-control";
import { GraphSnapshotCorruption } from "../task-authority/graph-authority-errors";
import type { GraphTaskCard } from "../task-authority/graph-control-schemas";
import { projectGraphTaskCards } from "../task-authority/graph-card";
import { graphTaskAuthorityPath } from "./paths";
import { missingGraphAuthority } from "./graph-authority-presence";

interface ReadView { identity: string; sourceSha256: string; tasks: GraphTaskCard[]; readyIds: string[] }
interface ReadScope { views: Map<string, ReadView>; closed: boolean }
const scope = new AsyncLocalStorage<ReadScope>();
// One Team per process. Retain only the immutable current projection, never
// controllers, raw snapshots, historical revisions, events or replay receipts.
let memo: { file: string; view: ReadView } | undefined;
let validationMemo: { file: string; validator: GraphSnapshotValidator } | undefined;

function identity(file: string): string {
  try {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile() || stat.ino <= 0n || stat.mtimeNs <= 0n || stat.ctimeNs <= 0n) throw new Error("Graph authority file identity is unavailable.");
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch (error) { memo = undefined; validationMemo = undefined; throw error; }
}
function assertCurrent(file: string, view: ReadView): void {
  if (identity(file) !== view.identity) {
    memo = undefined;
    validationMemo = undefined;
    throw new Error("Graph authority changed during observation; retry the operation.");
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Read-only operation scope. Never reuse a projection after its authority changes.
 * Mutation and delivery commits retain their own leases and fresh authority reads.
 */
export async function withGraphReadView<T>(action: () => Promise<T>): Promise<T> {
  const active = scope.getStore();
  if (active) {
    if (active.closed) throw new Error("Graph observation scope has ended.");
    return action();
  }
  const current: ReadScope = { views: new Map(), closed: false };
  return scope.run(current, async () => {
    try {
      const result = await action();
      for (const [file, view] of current.views) assertCurrent(file, view);
      return result;
    } finally { current.closed = true; current.views.clear(); }
  });
}

/** Call only under the caller's existing graph or retirement lease.
 * Metadata is the fast-path fence for the atomic snapshot writer. The digest
 * identifies validated source bytes; hits do not reread or rehash those bytes.
 */
function readView(teamName: string): ReadView {
  const file = graphTaskAuthorityPath(teamName);
  const active = scope.getStore();
  if (active?.closed) throw new Error("Graph observation scope has ended.");
  const scoped = active?.views.get(file);
  if (scoped) { assertCurrent(file, scoped); return scoped; }
  const before = identity(file);
  let view: ReadView;
  if (memo?.file === file && memo.view.identity === before) view = memo.view;
  else {
    memo = undefined;
    let sourceSha256 = "";
    const validator = validationMemo?.file === file ? validationMemo.validator : new GraphSnapshotValidator(true);
    let controller: GraphTaskController;
    try {
      controller = recoverGraphController(teamName, text => { sourceSha256 = createHash("sha256").update(text).digest("hex"); }, validator);
    } catch (error) { validationMemo = undefined; throw error; }
    view = freeze({ identity: before, sourceSha256, tasks: projectGraphTaskCards(controller), readyIds: controller.selectReadyFrontier().map(task => task.id) });
    assertCurrent(file, view);
    memo = { file, view };
    validationMemo = { file, validator };
  }
  if (active) active.views.set(file, view);
  return view;
}

export function readGraphTaskCards(teamName: string): GraphTaskCard[] {
  return structuredClone(readView(teamName).tasks);
}

export function readGraphReadyCards(teamName: string): GraphTaskCard[] {
  const view = readView(teamName);
  const ready = new Set(view.readyIds);
  return structuredClone(view.tasks.filter(task => ready.has(task.id)));
}

/** Commit checks bypass both memos and recover authority under their own lease. */
export function readGraphTaskCoordinates(teamName: string, mode: "observation" | "commit" = "commit"): Set<string> {
  const tasks = mode === "observation" ? readView(teamName).tasks : loadGraphController(teamName).readTasks();
  return new Set(tasks.map(task => `${task.id}\u0000${task.version}`));
}

/** Full validation remains mandatory for every recovered authority. */
export function loadGraphController(teamName: string): GraphTaskController {
  try { return recoverGraphController(teamName); }
  catch (error) { memo = undefined; validationMemo = undefined; throw error; }
}

function recoverGraphController(teamName: string, onSource?: (text: string) => void, validation?: GraphSnapshotValidator): GraphTaskController {
  const file = graphTaskAuthorityPath(teamName);
  if (!fs.existsSync(file)) throw missingGraphAuthority(teamName);
  let snapshot: GraphControlSnapshot;
  try {
    const text = fs.readFileSync(file, "utf8");
    snapshot = JSON.parse(text) as GraphControlSnapshot;
    onSource?.(text);
  } catch (error) {
    throw new GraphSnapshotCorruption(`Graph authority snapshot cannot be decoded: ${error instanceof Error ? error.message : String(error)}`);
  }
  const legacyModelFields = snapshot as unknown as {
    modelAliases?: unknown;
    graphRevisions?: Array<{ tasks?: Array<Record<string, unknown>> }>;
    events?: Array<Record<string, unknown>>;
  } | null;
  if (legacyModelFields && (legacyModelFields.modelAliases !== undefined
    || (Array.isArray(legacyModelFields.graphRevisions)
      && legacyModelFields.graphRevisions.some((revision) => Array.isArray(revision?.tasks)
        && revision.tasks.some((task) => task?.modelAlias !== undefined || task?.model !== undefined)))
    || (Array.isArray(legacyModelFields.events)
      && legacyModelFields.events.some((event) => event?.kind === "attempt_started"
        && (event.modelAlias !== undefined || event.resolvedModel !== undefined))))) {
    throw new GraphControlRefusal("invalid_graph", "Graph authority snapshot contains removed Task model selection fields; migration is not supported.");
  }
  try {
    return GraphTaskController.recover(snapshot, undefined, validation);
  } catch (error) {
    throw new GraphSnapshotCorruption(`Graph authority snapshot cannot be recovered: ${error instanceof Error ? error.message : String(error)}`);
  }
}
