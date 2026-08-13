import path from "node:path";
import { BeadsTaskStore } from "../utils/beads";
import { withLock } from "../utils/lock";
import { sanitizeName, teamDir } from "../utils/paths";
import { readConfig } from "../utils/teams";
import type {
  TaskMutationCoordinates,
  TaskMutationPublicationPort,
} from "../model-tool-contract/beads-authority-adapter";
import { projectTaskCard } from "../model-tool-contract/beads-task-adapter";
import type { TaskCard } from "../task-authority/task-domain";
import type { TaskVersionRef } from "../task-authority/task-version-ref";
import { BeadsTaskGraphAdapter } from "../task-authority/beads-graph-adapter";
import type { TaskGraphCreateInput } from "../task-authority/dag";
import type {
  TaskGraphOrchestrationOutcome,
  TaskOrchestrationPort,
} from "../task-authority/orchestration";
import {
  reconcileReadyTaskDeliveries,
  type TaskReadyDeliveryPort,
} from "../task-authority/ready-dispatch";

function coordinates(task: TaskCard): TaskMutationCoordinates {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    version: task.version as TaskVersionRef,
  };
}

/**
 * Composition adapter for atomic Beads graph writes, committed Task evidence,
 * and mechanical ready-front delivery. It owns no scheduling policy.
 */
export class DurableTaskOrchestration implements TaskOrchestrationPort {
  constructor(
    private readonly publication: TaskMutationPublicationPort,
    private readonly readyDelivery: TaskReadyDeliveryPort,
  ) {}

  async reconcileReady(teamName: string, worker?: string): Promise<string[]> {
    // Every Worker has a periodic recovery loop. Serialize the shared Task-
    // authority query so eight settled Workers do not start competing embedded
    // Dolt processes every poll and starve normal Task reads and writes.
    return withLock(path.join(teamDir(sanitizeName(teamName)), ".ready-reconciliation"), async () => {
      const config = await readConfig(teamName);
      if (config.taskBackend !== "beads" || !config.taskWorkspace || !config.taskAuthorityFingerprint) {
        throw new Error("The active Team has no exact Beads authority binding.");
      }
      const store = new BeadsTaskStore({
        teamName,
        workspace: config.taskWorkspace,
        authorityFingerprint: config.taskAuthorityFingerprint,
        requireExpectedVersion: true,
      });
      return reconcileReadyTaskDeliveries(teamName, {
        readDispatchSnapshot: async (recipient) => {
          const snapshot = await store.readReadyDispatchSnapshot(recipient);
          return {
            occupiedWorkers: snapshot.occupiedWorkers,
            readyTasks: snapshot.readyTasks.map((record) => {
              const projected = projectTaskCard(record);
              if ("kind" in projected) throw new Error(projected.message);
              return projected;
            }),
          };
        },
      }, this.readyDelivery, worker);
    });
  }

  async createGraph(teamName: string, input: TaskGraphCreateInput): Promise<TaskGraphOrchestrationOutcome> {
    let config;
    try {
      config = await readConfig(teamName);
      if (config.taskBackend !== "beads" || !config.taskWorkspace || !config.taskAuthorityFingerprint) {
        return {
          kind: "unavailable",
          operationId: input.operation_id,
          reason: "task_authority_unavailable",
          message: "The active Team has no exact Beads authority binding.",
        };
      }
    } catch (error) {
      return {
        kind: "unavailable",
        operationId: input.operation_id,
        reason: "task_authority_unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const store = new BeadsTaskStore({
      teamName,
      workspace: config.taskWorkspace,
      authorityFingerprint: config.taskAuthorityFingerprint,
      requireExpectedVersion: true,
    });
    const graph = new BeadsTaskGraphAdapter(
      teamName,
      store,
      async () => new Set((config.logicalWorkers ?? []).map((worker) => worker.name)),
    );
    const outcome = await graph.create(input);
    if (outcome.kind !== "created") return outcome;

    const deliveryWarnings: string[] = [];
    const createdEvidenceText = `Task created by atomic graph operation ${input.operation_id}.`;
    const relationEvidenceText = `Task dependencies expanded by atomic graph operation ${input.operation_id}.`;
    for (const task of Object.values(outcome.tasksByKey)) {
      try {
        const alreadyPublished = outcome.replayed && this.publication.hasTaskMutationPublication
          ? await this.publication.hasTaskMutationPublication({ teamName, taskId: task.id, taskVersion: task.version as TaskVersionRef, evidenceKind: "created", evidenceText: createdEvidenceText })
          : outcome.replayed;
        if (alreadyPublished) continue;
        const publication = await this.publication.publishTaskMutation({
          teamName,
          before: coordinates(task),
          after: coordinates(task),
          created: true,
          kind: task.assignee ? "assigned" : "task_changed",
          actor: "team-lead",
          taskEventEvidence: [{ kind: "created", text: createdEvidenceText }],
          // A graph assigns ownership atomically, but only the derived ready
          // frontier receives presentation intent.
          deliver: false,
          taskCard: task,
        });
        deliveryWarnings.push(...publication.warnings);
      } catch (error) {
        deliveryWarnings.push(`Task ${task.id} committed but publication recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const relationChanges = outcome.replayed
      ? outcome.expandedTasks.map((task) => ({ before: task, after: task }))
      : outcome.expandedTaskChanges;
    for (const change of relationChanges) {
      try {
        const alreadyPublished = outcome.replayed && this.publication.hasTaskMutationPublication
          ? await this.publication.hasTaskMutationPublication({ teamName, taskId: change.after.id, taskVersion: change.after.version as TaskVersionRef, evidenceKind: "relation", evidenceText: relationEvidenceText })
          : outcome.replayed;
        if (alreadyPublished) continue;
        const publication = await this.publication.publishTaskMutation({
          teamName,
          before: coordinates(change.before),
          after: coordinates(change.after),
          created: false,
          kind: "relation_changed",
          actor: "team-lead",
          taskEventEvidence: [{ kind: "relation", text: relationEvidenceText }],
          deliver: false,
          taskCard: change.after,
        });
        deliveryWarnings.push(...publication.warnings);
      } catch (error) {
        deliveryWarnings.push(`Task ${change.after.id} committed but relation publication recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      deliveryWarnings.push(...await this.reconcileReady(teamName));
    } catch (error) {
      deliveryWarnings.push(`Task graph committed but ready-delivery reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      kind: "created",
      operationId: outcome.operationId,
      replayed: outcome.replayed,
      tasksByKey: outcome.tasksByKey,
      readyTaskIds: outcome.readyTaskIds,
      deliveryWarnings: [...new Set(deliveryWarnings)].sort(),
    };
  }
}
