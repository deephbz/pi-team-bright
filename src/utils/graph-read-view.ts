import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { GraphControlRefusal, GraphTaskController, GraphObservationRecovery, type GraphControlSnapshot } from "../task-authority/graph-control";
import { GraphSnapshotCorruption } from "../task-authority/graph-authority-errors";
import type { GraphTaskCard } from "../task-authority/graph-control-schemas";
import { projectGraphTaskCards } from "../task-authority/graph-card";
import { graphTaskAuthorityPath } from "./paths";
import { missingGraphAuthority } from "./graph-authority-presence";

interface ReadView { teamName: string; identity: string; tasks: GraphTaskCard[]; readyIds: string[] }
interface ReadScope { views: Map<string, ReadView>; closed: boolean }
const scope = new AsyncLocalStorage<ReadScope>();
// One Team per process. Retain current cards and revision fingerprints only.
class GraphObservations {
  private file?: string;
  private view?: ReadView;
  private recovery = new GraphObservationRecovery();

  invalidate(): void {
    this.file = undefined;
    this.view = undefined;
    this.recovery = new GraphObservationRecovery();
  }

  read(teamName: string, file: string): ReadView {
    const before = identity(file, teamName);
    if (this.file === file && this.view?.identity === before) return this.view;
    if (this.file !== file) this.invalidate();
    this.view = undefined;
    try {
      const snapshot = readGraphSnapshot(teamName);
      let state;
      try { state = this.recovery.recover(snapshot); }
      catch (error) { throw recoveryCorruption(error); }
      const view = freeze({ teamName, identity: before, tasks: projectGraphTaskCards(state), readyIds: state.selectReadyFrontier().map(task => task.id) });
      assertCurrent(file, view);
      this.file = file;
      return this.view = view;
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }
}
const observations = new GraphObservations();

function identity(file: string, teamName: string): string {
  try {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile() || stat.ino <= 0n || stat.mtimeNs <= 0n || stat.ctimeNs <= 0n) throw new Error("Graph authority file identity is unavailable.");
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch (error) {
    observations.invalidate();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missingGraphAuthority(teamName);
    throw error;
  }
}
function assertCurrent(file: string, view: ReadView): void {
  if (identity(file, view.teamName) !== view.identity) {
    observations.invalidate();
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

/** Call only under the caller's graph or retirement lease.
 * Metadata fences the atomic snapshot writer; warm hits do not reread bytes.
 */
function readView(teamName: string): ReadView {
  const file = graphTaskAuthorityPath(teamName);
  const active = scope.getStore();
  if (active?.closed) throw new Error("Graph observation scope has ended.");
  const scoped = active?.views.get(file);
  if (scoped) { assertCurrent(file, scoped); return scoped; }
  const view = observations.read(teamName, file);
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

export function observeGraphTaskCoordinates(teamName: string): Set<string> {
  return new Set(readView(teamName).tasks.map(task => `${task.id}\u0000${task.version}`));
}

/** Commit checks recover fresh authority under their own lease. */
export function readGraphTaskCoordinates(teamName: string): Set<string> {
  return new Set(loadGraphController(teamName).readTasks().map(task => `${task.id}\u0000${task.version}`));
}

/** Full validation remains mandatory for every recovered authority. */
export function loadGraphController(teamName: string): GraphTaskController {
  try {
    const snapshot = readGraphSnapshot(teamName);
    try { return GraphTaskController.recover(snapshot); }
    catch (error) { throw recoveryCorruption(error); }
  } catch (error) { observations.invalidate(); throw error; }
}

function recoveryCorruption(error: unknown): GraphSnapshotCorruption {
  return new GraphSnapshotCorruption(`Graph authority snapshot cannot be recovered: ${error instanceof Error ? error.message : String(error)}`);
}

function readGraphSnapshot(teamName: string): GraphControlSnapshot {
  const file = graphTaskAuthorityPath(teamName);
  if (!fs.existsSync(file)) throw missingGraphAuthority(teamName);
  let snapshot: GraphControlSnapshot;
  try {
    const text = fs.readFileSync(file, "utf8");
    snapshot = JSON.parse(text) as GraphControlSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missingGraphAuthority(teamName);
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
  return snapshot;
}
