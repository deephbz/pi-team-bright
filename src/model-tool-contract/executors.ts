import type { Static } from "typebox";
import {
  EnsureWorkerParametersSchema,
  EnsureWorkerResultSchema,
  TaskCreateParametersSchema,
  TaskCreateResultSchema,
  TaskReadParametersSchema,
  TaskReadResultSchema,
  TaskUpdateParametersSchema,
  TaskUpdateResultSchema,
  TeamCreateParametersSchema,
  TeamCreateResultSchema,
  TeamSyncParametersSchema,
  TeamSyncResultSchema,
  WorkerStopParametersSchema,
  WorkerStopResultSchema,
  TeamShutdownParametersSchema,
  TeamShutdownResultSchema,
  TaskLinkParametersSchema,
  TaskLinkResultSchema,
  AlertSendParametersSchema,
  AlertSendResultSchema,
} from "./catalog";
import type { AlertTarget, EnsureWorkerExecutionContext, ExactLeaderSessionId, ModelToolWorkerCurrent, ReadTaskContractGap, TeamSyncPortResult } from "./model-tool-contracts";
import type { ModelToolJourneyPort } from "./model-tool-journey-port";
import type { CanonicalTaskCard } from "../task-authority/task-domain";
import type { TaskVersionRef } from "../task-authority/task-version-ref";
import { projectToolResult } from "./result-projection";

export type TeamCreateParameters = Static<typeof TeamCreateParametersSchema>;
export type TeamCreateResult = Static<typeof TeamCreateResultSchema>;
export type EnsureWorkerParameters = Static<typeof EnsureWorkerParametersSchema>;
export type EnsureWorkerResult = Static<typeof EnsureWorkerResultSchema>;
export type TaskCreateParameters = Static<typeof TaskCreateParametersSchema>;
export type TaskCreateResult = Static<typeof TaskCreateResultSchema>;
export type TaskReadParameters = Static<typeof TaskReadParametersSchema>;
export type TaskReadResult = Static<typeof TaskReadResultSchema>;
export type TaskUpdateParameters = Static<typeof TaskUpdateParametersSchema>;
export type TaskUpdateResult = Static<typeof TaskUpdateResultSchema>;
export type TeamSyncParameters = Static<typeof TeamSyncParametersSchema>;
export type TeamSyncResult = Static<typeof TeamSyncResultSchema>;
export type WorkerStopParameters = Static<typeof WorkerStopParametersSchema>;
export type WorkerStopResult = Static<typeof WorkerStopResultSchema>;
export type TeamShutdownParameters = Static<typeof TeamShutdownParametersSchema>;
export type TeamShutdownResult = Static<typeof TeamShutdownResultSchema>;
export type TaskLinkParameters = Static<typeof TaskLinkParametersSchema>;
export type TaskLinkResult = Static<typeof TaskLinkResultSchema>;
export type AlertSendParameters = Static<typeof AlertSendParametersSchema>;
export type AlertSendResult = Static<typeof AlertSendResultSchema>;

function isReadTaskContractGap(value: CanonicalTaskCard | ReadTaskContractGap): value is ReadTaskContractGap {
  return (value as ReadTaskContractGap).kind === "contract_gap";
}

function publicWorker(worker: ModelToolWorkerCurrent) {
  return { name: worker.name, scope: worker.scope, carrier: worker.carrier,
    ...(worker.modelRole ? { model_role: worker.modelRole } : {}) };
}

export interface ModelToolJourneyExecutors {
  teamCreate(leaderSessionId: ExactLeaderSessionId, parameters: TeamCreateParameters): Promise<TeamCreateResult>;
  ensureWorker(leaderSessionId: ExactLeaderSessionId, parameters: EnsureWorkerParameters, context?: EnsureWorkerExecutionContext): Promise<EnsureWorkerResult>;
  taskCreate(leaderSessionId: ExactLeaderSessionId, parameters: TaskCreateParameters): Promise<TaskCreateResult>;
  taskRead(leaderSessionId: ExactLeaderSessionId, parameters: TaskReadParameters): Promise<TaskReadResult>;
  taskUpdate(leaderSessionId: ExactLeaderSessionId, parameters: TaskUpdateParameters): Promise<TaskUpdateResult>;
  workerStop(leaderSessionId: ExactLeaderSessionId, parameters: WorkerStopParameters): Promise<WorkerStopResult>;
  teamShutdown(leaderSessionId: ExactLeaderSessionId, parameters: TeamShutdownParameters): Promise<TeamShutdownResult>;
  taskLink(leaderSessionId: ExactLeaderSessionId, parameters: TaskLinkParameters): Promise<TaskLinkResult>;
  alertSend(leaderSessionId: ExactLeaderSessionId, parameters: AlertSendParameters): Promise<AlertSendResult>;
  teamSync(leaderSessionId: ExactLeaderSessionId, parameters: TeamSyncParameters, signal?: AbortSignal, toolCallId?: string): Promise<TeamSyncResult>;
  teamSyncNow(leaderSessionId: ExactLeaderSessionId, parameters: TeamSyncParameters, signal?: AbortSignal, toolCallId?: string): Promise<TeamSyncResult | { kind: "quiet" } | { kind: "indeterminate"; message: string; state_changed: false; observation_advanced: false }>;
}

function projectSyncOutcome(port: ModelToolJourneyPort, leaderSessionId: ExactLeaderSessionId, outcome: TeamSyncPortResult): TeamSyncResult {
      if (outcome.kind === "unavailable") {
        return {
          kind: "unavailable",
          reason: outcome.reason,
          message: outcome.message,
          state_changed: false,
          observation_advanced: false,
        };
      }
      if (outcome.kind === "cancelled") {
        return {
          kind: "cancelled",
          message: outcome.message,
          state_changed: false,
          observation_advanced: false,
        };
      }
      if (outcome.kind === "contract_gap") {
        return {
          kind: "contract_gap",
          reason: outcome.reason,
          message: outcome.message,
          state_changed: false,
          observation_advanced: false,
        };
      }
      if (outcome.kind === "caught_up" || outcome.kind === "unsettled") {
        const common = { head: outcome.head, epoch_id: outcome.epochId, state_changed: false as const, observation_advanced: true as const };
        const result: TeamSyncResult = outcome.kind === "unsettled"
          ? { ...common, kind: "unsettled", workers: outcome.workers }
          : { ...common, kind: "caught_up" };
        port.coordination.setPendingObservationResult(leaderSessionId, projectToolResult("team_sync", result));
        return result;
      }
      if (outcome.kind === "refused") return {
        kind: "refused" as const,
        reason: outcome.reason,
        message: outcome.message,
        state_changed: false,
        observation_advanced: false,
      };
      const result = outcome.kind === "snapshot"
        ? {
          kind: "snapshot" as const,
          team: outcome.team,
          ...(outcome.modelRoles ? { model_roles: outcome.modelRoles } : {}),
          ...(outcome.defaultModelRole ? { default_model_role: outcome.defaultModelRole } : {}),
          workers: outcome.workers.map((worker) => ({ name: worker.name, scope: worker.scope, carrier: worker.carrier, ...(worker.modelRole ? { model_role: worker.modelRole } : {}), nonterminal_task_ids: worker.nonterminalTaskIds })),
          tasks: outcome.tasks,
          ...(outcome.taskProjectionWarnings?.length ? { task_projection_warnings: outcome.taskProjectionWarnings } : {}),
        }
        : {
          kind: "updates" as const,
          team_changes: outcome.teamChanges,
          worker_changes: outcome.workerChanges,
          task_changes: outcome.taskChanges.map((change) => ({ task_id: change.taskId, change_kinds: change.changeKinds, journal_entries: change.journalEntries, current: change.current })),
          alerts: outcome.alerts,
          ...(outcome.taskProjectionWarnings?.length ? { task_projection_warnings: outcome.taskProjectionWarnings } : {}),
        };
      port.coordination.setPendingObservationResult(leaderSessionId, projectToolResult("team_sync", result));
      return result;
}

export function createModelToolJourneyExecutors(port: ModelToolJourneyPort): ModelToolJourneyExecutors {
  return {
    async teamCreate(leaderSessionId, parameters) {
      const outcome = await port.team.createTeam(leaderSessionId, parameters);
      if (outcome.kind === "created") return { kind: "team_created", team: outcome.team, ...(outcome.modelRoles ? { model_roles: outcome.modelRoles } : {}), ...(outcome.defaultModelRole ? { default_model_role: outcome.defaultModelRole } : {}) };
      if (outcome.kind === "unavailable") {
        return { kind: "unavailable", reason: outcome.reason, message: outcome.message, state_changed: false };
      }
      return {
        kind: "refused",
        reason: outcome.reason,
        message: outcome.reason === "active_team_exists"
          ? "The exact leader Session already has an active Team."
          : `The Team name ${parameters.name} is unavailable.`,
        state_changed: false,
      };
    },

    async ensureWorker(leaderSessionId, parameters, context) {
      const outcome = await port.team.ensureWorker(leaderSessionId, parameters, context);
      if (outcome.kind === "no_active_team") {
        return {
          kind: "unavailable",
          reason: "no_active_team",
          message: "The exact leader Session is not bound to an active Team.",
          state_changed: false,
        };
      }
      if (outcome.kind === "scope_conflict") {
        return { kind: "refused", reason: "name_scope_conflict", existing_worker: publicWorker(outcome.worker), state_changed: false };
      }
      if (outcome.kind === "invalid_model_role") {
        return { kind: "refused", reason: "invalid_model_role", valid_model_roles: outcome.validModelRoles, message: outcome.message, state_changed: false };
      }
      if (outcome.kind === "legacy_team_model_default") {
        return { kind: "refused", reason: "legacy_team_model_default", message: outcome.message, state_changed: false };
      }
      if (outcome.kind === "model_conflict") {
        return { kind: "refused", reason: "model_conflict", existing_worker: publicWorker(outcome.worker), message: outcome.message, state_changed: false };
      }
      if (outcome.kind === "unavailable") {
        return { kind: "unavailable", reason: outcome.reason, message: outcome.message, state_changed: false };
      }
      return { kind: "worker_ensured", effect: outcome.kind === "created" ? "created" : "reused", worker: publicWorker(outcome.worker) };
    },

    async taskCreate(leaderSessionId, parameters) {
      const outcome = await port.task.createTaskGraph(leaderSessionId, {
        operationId: parameters.operation_id,
        ...(parameters.expected_graph_version ? { expectedGraphVersion: parameters.expected_graph_version as any } : {}),
        tasks: parameters.tasks.map(task => ({
          key: task.key,
          title: task.title,
          goal: task.goal,
          assignee: task.assignee,
          ...(task.needs ? { needs: [...task.needs] } : {}),
          ...(task.on_goal_failed ? { onGoalFailed: { target: task.on_goal_failed.target, maxTraversals: task.on_goal_failed.max_traversals } } : {}),
        })),
      });
      if (outcome.kind === "created") return {
        kind: "task_graph_applied",
        operation_id: outcome.operationId,
        graph_version: outcome.graphVersion,
        replayed: outcome.replayed,
        tasks_by_key: outcome.tasksByKey as any,
        ready_task_ids: outcome.readyTaskIds,
        ...(outcome.deliveryWarnings?.length ? { delivery_warnings: outcome.deliveryWarnings } : {}),
      };
      if (outcome.kind === "refused") return {
        kind: "refused",
        operation_id: outcome.operationId,
        reason: outcome.reason === "graph_conflict" ? "invalid_graph" : outcome.reason === "version_conflict" ? "graph_version_conflict" : outcome.reason,
        message: outcome.message,
        state_changed: false,
      };
      if (outcome.kind === "unknown_outcome") return { kind: "unknown_outcome", operation_id: outcome.operationId, message: outcome.message };
      return {
        kind: "unavailable",
        operation_id: outcome.operationId,
        reason: outcome.kind === "unavailable" ? outcome.reason : "no_active_team",
        message: outcome.kind === "unavailable" ? outcome.message : "The exact leader Session is not bound to an active Team.",
        state_changed: false,
      };
    },

    async taskRead(leaderSessionId, parameters) {
      const outcome = await port.task.readTasks(leaderSessionId, parameters.task_ids);
      if (outcome.kind === "no_active_team") {
        return {
          kind: "unavailable",
          reason: "no_active_team",
          message: "The exact leader Session is not bound to an active Team.",
          state_changed: false,
        };
      }
      if (outcome.kind === "unavailable") {
        return {
          kind: "unavailable",
          reason: outcome.reason,
          message: outcome.message,
          state_changed: false,
        };
      }
      return {
        kind: "task_read_batch",
        outcomes: outcome.tasks.map((task, inputIndex) => {
          const taskId = parameters.task_ids[inputIndex];
          if (task === undefined) {
            return { kind: "missing" as const, input_index: inputIndex, task_id: taskId, reason: "task_not_found" as const, state_changed: false as const };
          }
          if (isReadTaskContractGap(task)) {
            return {
              kind: "contract_gap" as const,
              input_index: inputIndex,
              task_id: taskId,
              reason: task.reason,
              version: task.version,
              message: task.message,
              ...(task.projectionWarning ? { projection_warning: task.projectionWarning } : {}),
              state_changed: false as const,
            };
          }
          return { kind: "found" as const, input_index: inputIndex, task_id: taskId, task };
        }),
      };
    },

    async taskUpdate(leaderSessionId, parameters) {
      const outcome = await port.task.updateTasks(leaderSessionId, [{
        taskId: parameters.task_id,
        operationId: parameters.operation_id,
        expectedVersion: parameters.expected_version as TaskVersionRef,
        ...(parameters.transition ? { transition: parameters.transition } : {}),
        ...(parameters.current_context ? { currentContext: parameters.current_context } : {}),
        ...(parameters.evidence ? { evidence: parameters.evidence } : {}),
      }]);
      if (outcome.kind === "no_active_team") return {
        kind: "unavailable",
        input_index: 0,
        task_id: parameters.task_id,
        operation_id: parameters.operation_id,
        reason: "no_active_team",
        message: "The exact leader Session is not bound to an active Team.",
        state_changed: false,
      };
      if (outcome.kind !== "batch" || !outcome.outcomes[0]) return {
        kind: "unavailable",
        input_index: 0,
        task_id: parameters.task_id,
        operation_id: parameters.operation_id,
        reason: "task_authority_unavailable",
        message: "Task authority returned no transition outcome.",
        state_changed: false,
      };
      const item = outcome.outcomes[0];
      if (item.kind === "updated") return {
        kind: "updated",
        input_index: 0,
        task_id: item.taskId,
        operation_id: item.operationId,
        replayed: item.replayed ?? false,
        transition: item.transition ?? parameters.transition ?? "context_updated",
        task: item.task as any,
        ready_task_ids: item.readyTaskIds ?? [],
        ...(item.failureTraversal ? { failure_traversal: {
          source_task_id: item.failureTraversal.sourceTaskId,
          target_task_id: item.failureTraversal.targetTaskId,
          traversal: item.failureTraversal.traversal,
        } } : {}),
        ...(item.deliveryWarnings?.length ? { delivery_warnings: item.deliveryWarnings } : {}),
      };
      if (item.kind === "refused") return {
        kind: "refused",
        input_index: 0,
        task_id: item.taskId,
        operation_id: item.operationId,
        reason: item.reason as any,
        message: item.message,
        ...(item.currentTask ? { current_task: item.currentTask as any } : {}),
        state_changed: false,
      };
      if (item.kind === "unknown_outcome") return {
        kind: "unknown_outcome",
        input_index: 0,
        task_id: item.taskId,
        operation_id: item.operationId,
        message: item.message,
      };
      return {
        kind: "unavailable",
        input_index: 0,
        task_id: item.taskId,
        operation_id: item.operationId,
        reason: "task_authority_unavailable",
        message: item.message,
        state_changed: false,
      };
    },

    async workerStop(leaderSessionId, parameters) {
      const outcome = await port.team.stopWorker(leaderSessionId, parameters.worker);
      if (outcome.kind === "stopped") return { kind: "worker_stopped", worker: outcome.worker, state_changed: true };
      if (outcome.kind === "unavailable") return { kind: "unavailable", reason: outcome.reason, message: outcome.message, state_changed: false };
      return {
        kind: "refused",
        reason: outcome.reason,
        worker: outcome.worker,
        message: outcome.message,
        state_changed: false,
        ...(outcome.guardingTaskIds ? { guarding_task_ids: outcome.guardingTaskIds } : {}),
      };
    },

    async teamShutdown(leaderSessionId, _parameters) {
      const outcome = await port.team.shutdownTeam(leaderSessionId);
      if (outcome.kind === "unavailable") return { kind: "unavailable", reason: outcome.reason, message: outcome.message, state_changed: false };
      if (outcome.kind === "partial") return {
        kind: "partial",
        lifecycle: "active",
        stopped_workers: outcome.stoppedWorkers,
        failed_workers: outcome.failedWorkers,
        unfinished_task_ids: outcome.unfinishedTaskIds,
        state_changed: true,
      };
      return {
        kind: "team_shutdown",
        lifecycle: "stopped",
        stopped_workers: outcome.stoppedWorkers,
        unfinished_task_ids: outcome.unfinishedTaskIds,
      };
    },

    async taskLink(leaderSessionId, parameters) {
      const outcome = await port.task.linkTask(leaderSessionId, {
        taskId: parameters.task_id,
        relation: parameters.relation,
        targetId: parameters.target_id,
        action: parameters.action,
        expectedVersion: parameters.expected_version as TaskVersionRef,
      });
      if (outcome.kind === "linked") return {
        kind: "task_linked",
        task_id: outcome.taskId,
        target_id: outcome.targetId,
        relation: outcome.relation,
        action: outcome.action,
        changed: outcome.changed,
        version: outcome.version,
      };
      if (outcome.kind === "unavailable") return { kind: "unavailable", reason: outcome.reason, message: outcome.message, state_changed: false };
      return { kind: "refused", task_id: outcome.taskId, reason: outcome.reason, message: outcome.message, state_changed: false };
    },

    async alertSend(leaderSessionId, parameters) {
      const target: AlertTarget = parameters.to === "*"
        ? { kind: "team" }
        : { kind: "worker", name: parameters.to };
      if ((target.kind === "team") !== (parameters.kind === "announcement")) {
        return {
          kind: "refused",
          reason: "invalid_fanout",
          message: "Use kind announcement only with to '*'; use clarification or attention with a Worker name.",
          state_changed: false,
        };
      }
      if (parameters.task_version && !parameters.task_id) {
        return {
          kind: "refused",
          reason: "invalid_fanout",
          message: "task_version requires task_id.",
          state_changed: false,
        };
      }
      const outcome = await port.alert.sendAlert(leaderSessionId, {
        target,
        kind: parameters.kind,
        text: parameters.text,
        taskId: parameters.task_id,
        taskVersion: parameters.task_version as TaskVersionRef,
      });
      if (outcome.kind === "sent") return {
        kind: "alert_sent",
        alert_id: outcome.alertId,
        accepted_recipients: outcome.acceptedRecipients,
        failed_recipients: outcome.failedRecipients,
        task_state_changed: false,
      };
      if (outcome.kind === "unavailable") return { kind: "unavailable", reason: outcome.reason, message: outcome.message, state_changed: false };
      return { kind: "refused", reason: outcome.reason, message: outcome.message, state_changed: false };
    },

    async teamSync(leaderSessionId, parameters, signal = new AbortController().signal, toolCallId = "team-sync") {
      const outcome = await port.coordination.readTeamSync(leaderSessionId, parameters.view, signal, toolCallId);
      return projectSyncOutcome(port, leaderSessionId, outcome);
    },
    async teamSyncNow(leaderSessionId, parameters, signal = new AbortController().signal, toolCallId = "team-sync-now") {
      if (!port.coordination.readTeamSyncNow) return { kind: "indeterminate", message: "Immediate Team observation is unavailable.", state_changed: false, observation_advanced: false };
      const outcome = await port.coordination.readTeamSyncNow(leaderSessionId, parameters.view, signal, toolCallId);
      if (outcome.kind === "quiet") return { kind: "quiet" };
      if (outcome.kind === "indeterminate") return { ...outcome, state_changed: false, observation_advanced: false };
      return projectSyncOutcome(port, leaderSessionId, outcome);
    },
  };
}
