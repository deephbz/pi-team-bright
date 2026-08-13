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
import type { AlertTarget, ExactLeaderSessionId, ReadTaskContractGap } from "./model-tool-contracts";
import type { ModelToolJourneyPort } from "./model-tool-journey-port";
import type { TaskCard } from "../task-authority/task-domain";
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

function isReadTaskContractGap(value: TaskCard | ReadTaskContractGap): value is ReadTaskContractGap {
  return (value as ReadTaskContractGap).kind === "contract_gap";
}

export interface ModelToolJourneyExecutors {
  teamCreate(leaderSessionId: ExactLeaderSessionId, parameters: TeamCreateParameters): Promise<TeamCreateResult>;
  ensureWorker(leaderSessionId: ExactLeaderSessionId, parameters: EnsureWorkerParameters): Promise<EnsureWorkerResult>;
  taskCreate(leaderSessionId: ExactLeaderSessionId, parameters: TaskCreateParameters): Promise<TaskCreateResult>;
  taskRead(leaderSessionId: ExactLeaderSessionId, parameters: TaskReadParameters): Promise<TaskReadResult>;
  taskUpdate(leaderSessionId: ExactLeaderSessionId, parameters: TaskUpdateParameters): Promise<TaskUpdateResult>;
  workerStop(leaderSessionId: ExactLeaderSessionId, parameters: WorkerStopParameters): Promise<WorkerStopResult>;
  teamShutdown(leaderSessionId: ExactLeaderSessionId, parameters: TeamShutdownParameters): Promise<TeamShutdownResult>;
  taskLink(leaderSessionId: ExactLeaderSessionId, parameters: TaskLinkParameters): Promise<TaskLinkResult>;
  alertSend(leaderSessionId: ExactLeaderSessionId, parameters: AlertSendParameters): Promise<AlertSendResult>;
  teamSync(leaderSessionId: ExactLeaderSessionId, parameters: TeamSyncParameters, signal?: AbortSignal, toolCallId?: string): Promise<TeamSyncResult>;
}

export function createModelToolJourneyExecutors(port: ModelToolJourneyPort): ModelToolJourneyExecutors {
  return {
    async teamCreate(leaderSessionId, parameters) {
      const outcome = await port.team.createTeam(leaderSessionId, parameters);
      if (outcome.kind === "created") return { kind: "team_created", team: outcome.team };
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

    async ensureWorker(leaderSessionId, parameters) {
      const outcome = await port.team.ensureWorker(leaderSessionId, parameters);
      if (outcome.kind === "no_active_team") {
        return {
          kind: "unavailable",
          reason: "no_active_team",
          message: "The exact leader Session is not bound to an active Team.",
          state_changed: false,
        };
      }
      if (outcome.kind === "scope_conflict") {
        return { kind: "refused", reason: "name_scope_conflict", existing_worker: outcome.worker, state_changed: false };
      }
      if (outcome.kind === "unavailable") {
        return { kind: "unavailable", reason: outcome.reason, message: outcome.message, state_changed: false };
      }
      return { kind: "worker_ensured", effect: outcome.kind, worker: outcome.worker };
    },

    async taskCreate(leaderSessionId, parameters) {
      const outcome = await port.task.createTaskGraph(leaderSessionId, {
        operationId: parameters.operation_id,
        tasks: parameters.tasks.map(task => ({
          key: task.key,
          title: task.title,
          goal: task.goal,
          assignee: task.assignee,
          ...(task.needs ? { needs: [...task.needs] } : {}),
        })),
      });
      if (outcome.kind === "created") return {
        kind: "task_graph_created",
        operation_id: outcome.operationId,
        replayed: outcome.replayed,
        tasks_by_key: outcome.tasksByKey,
        ready_task_ids: outcome.readyTaskIds,
        ...(outcome.deliveryWarnings?.length ? { delivery_warnings: outcome.deliveryWarnings } : {}),
      };
      if (outcome.kind === "refused") return { kind: "refused", operation_id: outcome.operationId, reason: outcome.reason, message: outcome.message, state_changed: false };
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
      const duplicateTaskIds = new Set<string>();
      const seenTaskIds = new Set<string>();
      for (const update of parameters.updates) {
        if (seenTaskIds.has(update.task_id)) duplicateTaskIds.add(update.task_id);
        seenTaskIds.add(update.task_id);
      }
      if (duplicateTaskIds.size > 0) {
        return {
          kind: "refused",
          reason: "duplicate_task_id",
          message: "The update batch contains duplicate Task IDs; no item was changed.",
          state_changed: false,
        };
      }

      const outcome = await port.task.updateTasks(leaderSessionId, parameters.updates.map((update) => ({
        taskId: update.task_id,
        operationId: update.operation_id,
        expectedVersion: update.expected_version as TaskVersionRef,
        currentContext: update.current_context,
        journalEntries: update.journal_entries,
        status: update.status,
      })));
      if (outcome.kind === "no_active_team") {
        return {
          kind: "unavailable",
          reason: "no_active_team",
          message: "The exact leader Session is not bound to an active Team.",
          state_changed: false,
        };
      }
      if (outcome.kind === "duplicate_task_id") {
        return {
          kind: "refused",
          reason: "duplicate_task_id",
          message: "The update batch contains duplicate Task IDs; no item was changed.",
          state_changed: false,
        };
      }
      return {
        kind: "task_update_batch",
        outcomes: outcome.outcomes.map((item, inputIndex) => item.kind === "updated"
          ? {
            kind: "updated",
            input_index: inputIndex,
            task_id: item.taskId,
            operation_id: item.operationId,
            task: item.task,
            journal_entries: item.journalEntries,
            ...(item.deliveryWarnings?.length ? { delivery_warnings: item.deliveryWarnings } : {}),
          }
          : item.kind === "refused"
            ? {
              kind: "refused",
              input_index: inputIndex,
              task_id: item.taskId,
              operation_id: item.operationId,
              reason: item.reason,
              message: item.message,
              ...(item.currentTask ? { current_task: item.currentTask } : {}),
              ...(item.blockerIds?.length ? { active_blocker_ids: item.blockerIds } : {}),
              state_changed: false,
            }
            : item.kind === "contract_gap"
              ? {
                kind: "contract_gap",
                input_index: inputIndex,
                task_id: item.taskId,
                operation_id: item.operationId,
                reason: item.reason,
                ...(item.currentTask ? { current_task: item.currentTask } : {}),
                unsupported: item.unsupported,
                message: item.message,
                state_changed: false,
              }
              : {
                kind: "unavailable",
                input_index: inputIndex,
                task_id: item.taskId,
                operation_id: item.operationId,
                reason: item.reason,
                message: item.message,
                state_changed: false,
              }),
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
      if (outcome.kind === "unavailable") {
        return {
          kind: "unavailable",
          reason: outcome.reason,
          message: outcome.message,
          state_changed: false,
          observation_advanced: false,
        };
      }
      if (outcome.kind === "snapshot_required") {
        return {
          kind: "snapshot_required",
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
      if (outcome.kind === "caught_up") {
        const result = {
          kind: "caught_up" as const,
          head: outcome.head,
          epoch_id: outcome.epochId,
          state_changed: false as const,
          observation_advanced: true as const,
        };
        port.coordination.setPendingObservationResult(leaderSessionId, projectToolResult("team_sync", result));
        return result;
      }
      if (outcome.kind === "indeterminate") return {
        kind: "indeterminate" as const,
        message: outcome.message,
        state_changed: false,
        observation_advanced: false,
      };
      const result = outcome.kind === "snapshot"
        ? {
          kind: "snapshot" as const,
          team: outcome.team,
          workers: outcome.workers.map((worker) => ({ name: worker.name, scope: worker.scope, carrier: worker.carrier, nonterminal_task_ids: worker.nonterminalTaskIds })),
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
    },
  };
}
