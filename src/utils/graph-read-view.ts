import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { GraphControlRefusal, GraphTaskController, type GraphControlSnapshot } from "../task-authority/graph-control";
import { GraphSnapshotCorruption } from "../task-authority/graph-authority-errors";
import type { GraphTaskCard } from "../task-authority/graph-control-schemas";
import { projectGraphTaskCards } from "../task-authority/graph-card";
import { graphTaskAuthorityPath } from "./paths";
import { missingGraphAuthority } from "./graph-authority-presence";

interface ReadView { identity: string; tasks: GraphTaskCard[] }
interface ReadScope { views: Map<string, ReadView>; closed: boolean }
const scope = new AsyncLocalStorage<ReadScope>();

function identity(file: string): string {
  const stat = fs.statSync(file, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function assertCurrent(file: string, view: ReadView): void {
  if (identity(file) !== view.identity) throw new Error("Graph authority changed during observation; retry the operation.");
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

/** Call under the caller's existing graph or retirement lease. */
export function readGraphTaskCards(teamName: string): GraphTaskCard[] {
  const file = graphTaskAuthorityPath(teamName);
  const active = scope.getStore();
  if (active?.closed) throw new Error("Graph observation scope has ended.");
  const cached = active?.views.get(file);
  if (cached) {
    assertCurrent(file, cached);
    return structuredClone(cached.tasks);
  }
  const before = identity(file);
  const tasks = projectGraphTaskCards(loadGraphController(teamName));
  const view = { identity: before, tasks };
  assertCurrent(file, view);
  if (active) active.views.set(file, { ...view, tasks: freeze(tasks) });
  return structuredClone(tasks);
}

/** Commit-time checks outside an observation keep their fresh scalar read path. */
export function readGraphTaskCoordinates(teamName: string): Set<string> {
  const tasks = scope.getStore() ? readGraphTaskCards(teamName) : loadGraphController(teamName).readTasks();
  return new Set(tasks.map(task => `${task.id}\u0000${task.version}`));
}

/** Full validation remains mandatory for every recovered authority. */
export function loadGraphController(teamName: string): GraphTaskController {
  const file = graphTaskAuthorityPath(teamName);
  if (!fs.existsSync(file)) throw missingGraphAuthority(teamName);
  let snapshot: GraphControlSnapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as GraphControlSnapshot;
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
    return GraphTaskController.recover(snapshot);
  } catch (error) {
    throw new GraphSnapshotCorruption(`Graph authority snapshot cannot be recovered: ${error instanceof Error ? error.message : String(error)}`);
  }
}
