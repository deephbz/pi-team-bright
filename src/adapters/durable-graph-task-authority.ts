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
import { loadGraphController, readGraphTaskCards } from "../utils/graph-read-view";
import { withLock } from "../utils/lock";
import { configPath, graphTaskAuthorityPath, teamDir } from "../utils/paths";
import { withCurrentSessionBinding } from "../utils/teams";
import { GraphSnapshotCorruption } from "../task-authority/graph-authority-errors";
import { missingGraphAuthority as missingAuthority } from "../utils/graph-authority-presence";

export interface GraphMutationBinding {
  agentName: string;
  membershipId: string;
  sessionFile: string;
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
    if (!this.exists(teamName) && (fs.existsSync(configPath(teamName)) || fs.existsSync(path.join(teamDir(teamName), ".beads")))) throw missingAuthority(teamName);
    await withLock(file, async () => {
      if (this.exists(teamName)) { this.loadRequired(teamName); return; }
      if (fs.existsSync(configPath(teamName)) || fs.existsSync(path.join(teamDir(teamName), ".beads"))) {
        throw missingAuthority(teamName);
      }
      writeJsonAtomic(file, new GraphTaskController().snapshot());
    });
  }

  async applyGraph(teamName: string, input: GraphApplyInput, binding?: GraphMutationBinding): Promise<GraphAuthorityMutation<GraphApplyResult>> {
    return this.mutate(teamName, input.operationId, (controller) => controller.applyGraph(input), binding);
  }

  async transition(teamName: string, input: GraphTaskTransitionInput, binding?: GraphMutationBinding): Promise<GraphAuthorityMutation<GraphTransitionResult>> {
    return this.mutate(teamName, input.operationId, (controller) => controller.transition(input), binding);
  }

  async readTasks(teamName: string, taskIds?: readonly string[]): Promise<GraphTaskCard[]> {
    if (!this.exists(teamName)) throw missingAuthority(teamName);
    return withLock(graphTaskAuthorityPath(teamName), async () => {
      const all = readGraphTaskCards(teamName);
      if (!taskIds) return all;
      const byId = new Map(all.map((task) => [task.id, task]));
      return taskIds.flatMap((taskId) => byId.get(taskId) ?? []);
    });
  }

  async readTask(teamName: string, taskId: string): Promise<GraphTaskCard | undefined> {
    return (await this.readTasks(teamName, [taskId]))[0];
  }

  async readyFrontier(teamName: string, worker?: string): Promise<GraphTaskCard[]> {
    if (!this.exists(teamName)) throw missingAuthority(teamName);
    return withLock(graphTaskAuthorityPath(teamName), async () => {
      const controller = this.loadRequired(teamName);
      const byId = new Map(cards(controller).map((task) => [task.id, task]));
      return controller.selectReadyFrontier()
        .flatMap((task) => byId.get(task.id) ?? [])
        .filter((task) => !worker || task.assignee === worker);
    });
  }

  async trace(teamName: string): Promise<ReturnType<GraphTaskController["trace"]>> {
    if (!this.exists(teamName)) throw missingAuthority(teamName);
    return withLock(graphTaskAuthorityPath(teamName), async () => this.loadRequired(teamName).trace());
  }

  private async mutate<Result extends GraphApplyResult | GraphTransitionResult>(
    teamName: string,
    operationId: string,
    apply: (controller: GraphTaskController) => Result & { replayed: boolean },
    binding?: GraphMutationBinding,
  ): Promise<GraphAuthorityMutation<Result>> {
    // Lock order: exact Membership, brief TeamConfig recheck, graph authority.
    // Release the Membership before downstream publication takes delivery locks.
    if (binding) return withCurrentSessionBinding(teamName, binding.agentName, binding.sessionFile, binding.membershipId,
      () => this.mutate(teamName, operationId, apply));
    if (!this.exists(teamName)) throw missingAuthority(teamName);
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
    return loadGraphController(teamName);
  }
}
