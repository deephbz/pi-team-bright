import fs from "node:fs";
import path from "node:path";
import {
  GraphControlRefusal,
  GraphTaskController,
  type GraphApplyInput,
  type GraphApplyResult,
  type GraphControlSnapshot,
  type GraphTaskTransitionInput,
  type GraphVersionRef,
  type GraphTransitionResult,
} from "../task-authority/graph-control";
import type { GraphTaskCard } from "../task-authority/graph-control-schemas";
import { projectGraphTaskCards as cards } from "../task-authority/graph-card";
import { writeJsonAtomic } from "../utils/atomic-json";
import { withLock } from "../utils/lock";
import { configPath, graphTaskAuthorityPath, teamDir } from "../utils/paths";

export const UNSUPPORTED_BEADS_TEAM = "This Team keeps its Tasks in Beads. PTB 0.24 does not support it. The data stays in .beads/.";

function missingAuthority(teamName: string): Error {
  let config: { taskBackend?: string } = {};
  try { config = JSON.parse(fs.readFileSync(configPath(teamName), "utf8")); } catch {}
  return config.taskBackend === "beads" || fs.existsSync(path.join(teamDir(teamName), ".beads"))
    ? new UnsupportedBeadsTeamError()
    : new GraphSnapshotCorruption(`Team ${teamName} has no graph-native Task authority snapshot. Restore its graph authority before continuing.`);
}

/** Stored authority cannot be decoded or recovered; distinct from invalid graph input. */
export class GraphSnapshotCorruption extends GraphControlRefusal {
  constructor(message: string) {
    super("invalid_graph", message);
    this.name = "GraphSnapshotCorruption";
  }
}

/** Unsupported stores cannot recover through delivery retry. */
export class UnsupportedBeadsTeamError extends GraphSnapshotCorruption {
  constructor() {
    super(UNSUPPORTED_BEADS_TEAM);
    this.name = "UnsupportedBeadsTeamError";
  }
}

export interface GraphAuthorityMutation<Result> {
  result: Result & { replayed: boolean };
  /** Monotonic graph-revision sequence after the mutation. */
  graphSequence: number;
  /** Monotonic graph event/revision sequence after the mutation. */
  authoritySequence: number;
  graphVersion: GraphVersionRef;
  before: GraphTaskCard[];
  after: GraphTaskCard[];
  ready: GraphTaskCard[];
  /** Exact committed command boundary, including when a later command has changed the graph. */
  operationBefore: GraphTaskCard[];
  operationAfter: GraphTaskCard[];
  operationGraphSequence: number;
  operationAuthoritySequence: number;
  operationGraphVersion: GraphVersionRef;
}

function atSequence(snapshot: GraphControlSnapshot, sequence: number): GraphTaskController {
  return new GraphTaskController({
    schema: snapshot.schema,
    graphRevisions: snapshot.graphRevisions.filter((revision) => revision.sequence <= sequence),
    events: snapshot.events.filter((event) => event.sequence <= sequence),
    receipts: [],
  });
}

function committedBoundary(
  snapshot: GraphControlSnapshot,
  result: GraphApplyResult | GraphTransitionResult,
): Pick<GraphAuthorityMutation<GraphApplyResult | GraphTransitionResult>,
  "operationBefore" | "operationAfter" | "operationGraphSequence" | "operationAuthoritySequence" | "operationGraphVersion"> {
  const firstRevision = result.kind === "graph_applied"
    ? snapshot.graphRevisions.find((revision) => revision.version === result.graphVersion)
    : undefined;
  const events = snapshot.events.filter((event) => event.operationId === result.operationId);
  const firstSequence = firstRevision?.sequence ?? events[0]?.sequence;
  const lastSequence = Math.max(firstRevision?.sequence ?? 0, ...events.map((event) => event.sequence));
  if (firstSequence === undefined || !Number.isSafeInteger(lastSequence) || lastSequence < firstSequence) {
    throw new GraphControlRefusal("invalid_graph", `Operation ${result.operationId} has no committed graph boundary.`);
  }
  const operationAfterController = atSequence(snapshot, lastSequence);
  const revision = operationAfterController.trace().graphRevisions.at(-1);
  if (!revision) throw new GraphControlRefusal("invalid_graph", `Operation ${result.operationId} has no graph revision.`);
  return {
    operationBefore: cards(atSequence(snapshot, firstSequence - 1)),
    operationAfter: cards(operationAfterController),
    operationGraphSequence: revision.sequence,
    operationAuthoritySequence: lastSequence,
    operationGraphVersion: revision.version,
  };
}

/** Team-scoped durable composition around the backend-neutral controller. */
export class DurableGraphTaskAuthority {

  exists(teamName: string): boolean {
    return fs.existsSync(graphTaskAuthorityPath(teamName));
  }

  /** Called only by new-Team creation while it owns the topology lease. */
  async initializeEmpty(teamName: string): Promise<void> {
    const file = graphTaskAuthorityPath(teamName);
    await withLock(file, async () => {
      if (this.exists(teamName)) { this.loadRequired(teamName); return; }
      if (fs.existsSync(configPath(teamName)) || fs.existsSync(path.join(teamDir(teamName), ".beads"))) {
        throw missingAuthority(teamName);
      }
      writeJsonAtomic(file, new GraphTaskController().snapshot());
    });
  }

  async applyGraph(teamName: string, input: GraphApplyInput): Promise<GraphAuthorityMutation<GraphApplyResult>> {
    return this.mutate(teamName, input.operationId, (controller) => controller.applyGraph(input));
  }

  async transition(teamName: string, input: GraphTaskTransitionInput): Promise<GraphAuthorityMutation<GraphTransitionResult>> {
    return this.mutate(teamName, input.operationId, (controller) => controller.transition(input));
  }

  async readTasks(teamName: string, taskIds?: readonly string[]): Promise<GraphTaskCard[]> {
    return withLock(graphTaskAuthorityPath(teamName), async () => {
      const controller = this.loadRequired(teamName);
      const all = cards(controller);
      if (!taskIds) return all;
      const byId = new Map(all.map((task) => [task.id, task]));
      return taskIds.flatMap((taskId) => byId.get(taskId) ?? []);
    });
  }

  async readTask(teamName: string, taskId: string): Promise<GraphTaskCard | undefined> {
    return (await this.readTasks(teamName, [taskId]))[0];
  }

  async readyFrontier(teamName: string, worker?: string): Promise<GraphTaskCard[]> {
    return withLock(graphTaskAuthorityPath(teamName), async () => {
      const controller = this.loadRequired(teamName);
      const byId = new Map(cards(controller).map((task) => [task.id, task]));
      return controller.selectReadyFrontier()
        .flatMap((task) => byId.get(task.id) ?? [])
        .filter((task) => !worker || task.assignee === worker);
    });
  }

  async trace(teamName: string): Promise<ReturnType<GraphTaskController["trace"]>> {
    return withLock(graphTaskAuthorityPath(teamName), async () => this.loadRequired(teamName).trace());
  }

  private async mutate<Result extends GraphApplyResult | GraphTransitionResult>(
    teamName: string,
    operationId: string,
    apply: (controller: GraphTaskController) => Result & { replayed: boolean },
  ): Promise<GraphAuthorityMutation<Result>> {
    const file = graphTaskAuthorityPath(teamName);
    return withLock(file, async () => {
      const controller = this.loadRequired(teamName);
      const before = cards(controller);
      const existingReceipt = controller.hasOperationReceipt(operationId);
      let result: Result & { replayed: boolean };
      try {
        result = apply(controller);
      } catch (error) {
        if (existingReceipt && error instanceof GraphControlRefusal && error.code === "invalid_graph") {
          throw new GraphSnapshotCorruption(`Graph authority replay receipt cannot be recovered: ${error.message}`);
        }
        throw error;
      }
      const snapshot = controller.snapshot();
      if (!result.replayed) writeJsonAtomic(file, snapshot);
      const after = cards(controller);
      const readyIds = new Set(controller.selectReadyFrontier().map((task) => task.id));
      const trace = controller.trace();
      const revision = trace.graphRevisions.at(-1);
      const graphSequence = revision?.sequence;
      if (!revision || graphSequence === undefined) throw new GraphControlRefusal("invalid_graph", "Committed graph has no current revision sequence.");
      const authoritySequence = Math.max(
        graphSequence,
        ...trace.events.map((event) => event.sequence),
      );
      let boundary: ReturnType<typeof committedBoundary>;
      try {
        boundary = result.replayed
          ? committedBoundary(snapshot, result)
          : {
          operationBefore: before,
          operationAfter: after,
          operationGraphSequence: graphSequence,
          operationAuthoritySequence: authoritySequence,
          operationGraphVersion: revision.version,
        };
      } catch (error) {
        if (result.replayed && error instanceof GraphControlRefusal && error.code === "invalid_graph") {
          throw new GraphSnapshotCorruption(`Graph authority replay boundary cannot be recovered: ${error.message}`);
        }
        throw error;
      }
      return { result, graphSequence, authoritySequence, graphVersion: revision.version, before, after, ready: after.filter((task) => readyIds.has(task.id)), ...boundary };
    });
  }

  private loadRequired(teamName: string): GraphTaskController {
    if (!this.exists(teamName)) throw missingAuthority(teamName);
    return this.load(teamName);
  }

  private load(teamName: string): GraphTaskController {
    const file = graphTaskAuthorityPath(teamName);
    if (!fs.existsSync(file)) throw missingAuthority(teamName);
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
}
