import {
  completeOwnerTransitionIntent,
  enqueueTaskChangeForRecipient,
  prepareOwnerTransitionIntent,
  recordTaskDeliveryRecovery,
  suppressTaskVersionForSession,
  readTaskDeliveries,
  readTaskDeliveryTombstones,
} from "../utils/task-delivery";
import {
  appendTaskEvidenceEvent,
  projectTaskEventEvidence,
  readTeamEvents,
} from "../coordination/event-journal";
import { appendTaskEventFailureHint } from "../utils/task-event-failure-hints";
import { readConfig } from "../utils/teams";
import type {
  TaskMutationChangeKind,
  TaskMutationEventEvidenceInput,
  TaskMutationPublicationInput,
  TaskMutationPublicationPort,
  TaskMutationSuppressionInput,
  TaskMutationPublicationRecoveryInput,
  TaskOwnerTransitionCompletionInput,
  TaskOwnerTransitionPreparationInput,
  TaskPublicationEvidence,
} from "../model-tool-contract/beads-authority-adapter";
import type { TaskVersionRef } from "../task-authority/task-version-ref";
import type { TaskCard } from "../task-authority/task-domain";
import type { TaskReadyDeliveryPort } from "../task-authority/ready-dispatch";

function defaultTaskEventEvidence(input: TaskMutationPublicationInput): TaskMutationEventEvidenceInput {
  if (input.created) return { kind: "created", text: "Task created." };
  if (input.kind === "assigned" || input.kind === "ownership_lost") {
    return { kind: "assignment", text: `Task assignee changed to ${input.after.assignee ?? "unassigned"}.` };
  }
  if (input.kind === "status_changed") return { kind: "status", text: `Task status changed to ${input.after.status}.` };
  if (input.kind === "relation_changed") return { kind: "relation", text: "Task relation changed." };
  if (input.kind === "note_appended") return { kind: "note", text: "Task note changed." };
  return { kind: "goal", text: "Task contract changed." };
}

function deliveryTargets(input: TaskMutationPublicationInput): Array<{ recipient: string; kind: TaskMutationChangeKind }> {
  const targets: Array<{ recipient: string; kind: TaskMutationChangeKind }> = [];
  if (input.before.assignee && input.before.assignee !== input.after.assignee) {
    targets.push({ recipient: input.before.assignee, kind: "ownership_lost" });
  }
  if (input.after.assignee) targets.push({ recipient: input.after.assignee, kind: input.kind });
  return [...new Map(targets.map((target) => [`${target.recipient}:${target.kind}`, target])).values()];
}

/** Durable Coordination and delivery bridge for committed Task mutations. */
export class DurableTaskMutationPublication implements TaskMutationPublicationPort, TaskReadyDeliveryPort {
  prepareOwnerTransitionIntent(input: TaskOwnerTransitionPreparationInput): Promise<boolean> {
    return prepareOwnerTransitionIntent(input);
  }

  suppressTaskVersionForSession(input: TaskMutationSuppressionInput): Promise<void> {
    return suppressTaskVersionForSession(input.teamName, input.recipient, input.sessionFile, input.task);
  }

  completeOwnerTransitionIntent(input: TaskOwnerTransitionCompletionInput): Promise<string[]> {
    return completeOwnerTransitionIntent(input.teamName, input.operationId, input.task, {});
  }

  async hasTaskMutationPublication(input: TaskMutationPublicationRecoveryInput): Promise<boolean> {
    let cursor: string | undefined;
    do {
      const batch = readTeamEvents(input.teamName, cursor === undefined ? {} : { afterCursor: cursor });
      if (batch.events.some((event) => event.type === "task"
        && event.ref.taskId === input.taskId
        && projectTaskEventEvidence(event)?.kind === input.evidenceKind
        && projectTaskEventEvidence(event)?.text === input.evidenceText)) return true;
      if (!batch.truncated) return false;
      if (batch.cursor === cursor) throw new Error("Task publication recovery pagination did not advance.");
      cursor = batch.cursor;
    } while (cursor !== undefined);
    return false;
  }

  async readDeliveryCoordinates(teamName: string, worker: string) {
    const [pending, observed] = await Promise.all([
      readTaskDeliveries(teamName, worker),
      readTaskDeliveryTombstones(teamName, worker),
    ]);
    return [...pending, ...observed].map((record) => ({
      taskId: record.ref.taskId,
      taskVersion: record.ref.version,
      worker,
      state: "presented" as const,
    }));
  }

  async enqueueReadyTask(teamName: string, task: TaskCard, worker: string): Promise<boolean> {
    try {
      return !!await enqueueTaskChangeForRecipient(teamName, task, worker, "assigned");
    } catch (error) {
      try {
        await recordTaskDeliveryRecovery({
          teamName,
          taskId: task.id,
          taskVersion: task.version as TaskVersionRef,
          recipients: [worker],
          changeKind: "assigned",
          recordedAt: new Date().toISOString(),
          reason: "enqueue-failed",
          taskProjection: task,
        });
      } catch (recoveryError) {
        throw new Error(`delivery enqueue failed and recovery evidence could not be persisted: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`, { cause: error });
      }
      throw error;
    }
  }

  async publishTaskMutation(input: TaskMutationPublicationInput): Promise<{ warnings: string[]; evidence: TaskPublicationEvidence }> {
    const targets = deliveryTargets(input);
    const warnings: string[] = [];
    let teamEventAppended = false;
    const failedRecipients: string[] = [];
    const recoveryRecordedFor: string[] = [];
    const recoveryRecordFailedFor: string[] = [];
    const actorName = input.actor ?? "external";
    const publicationVersion = (input.taskCard?.version ?? input.after.version) as TaskVersionRef;

    try {
      const change = input.kind === "assigned" || input.kind === "ownership_lost" ? "assigned" as const
        : input.kind === "status_changed" ? "status" as const
        : input.kind === "note_appended" ? "note" as const
        : input.kind === "relation_changed" ? "relation" as const
        : "goal" as const;
      const baseEvent = {
        type: "task" as const,
        ref: { taskId: input.after.id, version: publicationVersion },
        change,
        actor: actorName,
      };
      const evidenceEntries = input.taskEventEvidence.length > 0
        ? input.taskEventEvidence
        : [defaultTaskEventEvidence(input)];
      for (const [index, evidence] of evidenceEntries.entries()) {
        await appendTaskEvidenceEvent(input.teamName, {
          ...baseEvent,
          change: index === 0 ? change : "note",
          taskEvidence: evidence,
        });
      }
      teamEventAppended = true;
    } catch (error) {
      warnings.push(`Task ${input.after.id} committed but its Team event was not recorded: ${error instanceof Error ? error.message : String(error)}`);
      try {
        const config = await readConfig(input.teamName);
        await appendTaskEventFailureHint(input.teamName, {
          teamEpochId: config.epochId ?? "",
          taskId: input.after.id,
          taskVersion: publicationVersion,
          actor: actorName,
          at: new Date().toISOString(),
        });
      } catch (hintError) {
        const warning = `Task ${input.after.id} committed but failed-event hint persistence also failed: ${hintError instanceof Error ? hintError.message : String(hintError)}`;
        warnings.push(warning);
        console.warn(`[pi-teams] ${warning}`);
      }
    }

    const recipients = input.deliver ? targets : [];
    for (const target of recipients) {
      try {
        if (!input.taskCard) throw new Error(`Task ${input.after.id} has no canonical post-state card for delivery publication.`);
        await enqueueTaskChangeForRecipient(input.teamName, input.taskCard, target.recipient, target.kind);
      } catch (error) {
        const warning = `Task ${input.after.id} committed but delivery enqueue for ${target.recipient} failed`;
        warnings.push(warning);
        failedRecipients.push(target.recipient);
        try {
          if (!input.taskCard) throw new Error(`Task ${input.after.id} has no canonical card for delivery recovery.`);
          await recordTaskDeliveryRecovery({
            teamName: input.teamName,
            taskId: input.after.id,
            taskVersion: publicationVersion,
            recipients: [target.recipient],
            changeKind: target.kind,
            recordedAt: new Date().toISOString(),
            reason: "enqueue-failed",
            taskProjection: input.taskCard,
          });
          recoveryRecordedFor.push(target.recipient);
        } catch {
          warnings.push(`${warning}; recovery evidence could not be persisted`);
          recoveryRecordFailedFor.push(target.recipient);
        }
        console.warn(`[pi-teams] ${warning}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      warnings,
      evidence: {
        teamEvent: { appended: teamEventAppended },
        delivery: {
          attemptedRecipients: [...new Set(recipients.map((target) => target.recipient))],
          failedRecipients: [...new Set(failedRecipients)],
          recoveryRecordedFor: [...new Set(recoveryRecordedFor)],
          recoveryRecordFailedFor: [...new Set(recoveryRecordFailedFor)],
        },
      },
    };
  }
}
