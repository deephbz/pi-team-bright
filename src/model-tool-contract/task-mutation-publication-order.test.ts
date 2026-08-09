import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  order: [] as string[],
  config: {
    name: "publication-order-team",
    taskBackend: "beads",
    taskWorkspace: "/tmp/publication-order-team",
    taskAuthorityId: "authority-1",
    taskAuthorityFingerprint: {
      schema: "pi-teams-beads-authority/1",
      backend: "dolt",
      database: "dolt",
      doltDatabase: "publication_order_team",
      projectId: "publication-order-team",
    },
  },
}));

vi.mock("../utils/teams", () => ({
  teamExists: vi.fn(() => true),
  readConfig: vi.fn(async () => fixture.config),
  assertCurrentSessionBinding: vi.fn(),
  assertNoOrphanedBeadsCutover: vi.fn(),
  withCurrentSessionBinding: vi.fn(async (
    _teamName: string,
    _actor: string,
    _sessionFile: string,
    _membershipId: string,
    action: (config: typeof fixture.config) => Promise<unknown>,
  ) => {
    fixture.order.push("lease:start");
    const result = await action(fixture.config);
    fixture.order.push("lease:end");
    return result;
  }),
}));

import { BeadsTaskStore, TASK_METADATA_SCHEMA, type TaskAuthorityRecord, type TaskAuthorityRecordEnvelope } from "../utils/beads";
import {
  applySemanticTaskUpdate,
  createTask,
  type TaskMutationPublicationPort,
} from "./beads-authority-adapter";
import { taskVersionRef } from "./task-version-ref";

const beforeTask: TaskAuthorityRecord = {
  id: "task-1",
  title: "Publication order",
  description: "Preserve causal order.",
  acceptanceCriteria: "The port runs after commit and lease release.",
  status: "in_progress",
  assignee: "team-lead",
  relations: [],
  version: "beads_v1",
  provenance: { authority: "beads", teamName: fixture.config.name },
};
const afterTask: TaskAuthorityRecord = {
  ...beforeTask,
  assignee: "worker",
  version: "beads_v2",
};
const metadata = {
  schema: TASK_METADATA_SCHEMA,
  goal: "Preserve causal order.",
  current_context: "Ready.",
};
const beforeEnvelope: TaskAuthorityRecordEnvelope = { task: beforeTask, taskMetadata: metadata };
const afterEnvelope: TaskAuthorityRecordEnvelope = { task: afterTask, taskMetadata: metadata };

function card(envelope: TaskAuthorityRecordEnvelope) {
  return {
    id: envelope.task.id,
    title: envelope.task.title,
    goal: metadata.goal,
    status: envelope.task.status,
    ...(envelope.task.assignee ? { assignee: envelope.task.assignee } : {}),
    current_context: metadata.current_context,
    version: taskVersionRef(envelope.task.version),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function silentPublicationPort(): TaskMutationPublicationPort {
  return {
    prepareOwnerTransitionIntent: vi.fn(async () => true),
    suppressTaskVersionForSession: vi.fn(async () => undefined),
    publishTaskMutation: vi.fn(async () => ({
      warnings: [],
      evidence: {
        teamEvent: { appended: true },
        delivery: {
          attemptedRecipients: [],
          failedRecipients: [],
          recoveryRecordedFor: [],
          recoveryRecordFailedFor: [],
        },
      },
    })),
    completeOwnerTransitionIntent: vi.fn(async () => []),
  };
}

describe("Task mutation publication port order", () => {
  beforeEach(() => {
    fixture.order.length = 0;
    vi.restoreAllMocks();
    fs.mkdirSync(path.join(fixture.config.taskWorkspace, ".beads"), { recursive: true });
    fs.writeFileSync(path.join(fixture.config.taskWorkspace, ".beads", "metadata.json"), JSON.stringify({
      backend: "dolt",
      database: "dolt",
      dolt_database: fixture.config.taskAuthorityFingerprint.doltDatabase,
      project_id: fixture.config.taskAuthorityFingerprint.projectId,
    }));
  });

  afterEach(() => {
    fs.rmSync(fixture.config.taskWorkspace, { recursive: true, force: true });
  });

  it("forces preparation inside the lease and a blocked event after lease release", async () => {
    const prepareEntered = deferred();
    const releasePrepare = deferred();
    const eventEntered = deferred();
    const releaseEvent = deferred();
    vi.spyOn(BeadsTaskStore.prototype, "updateWithResult").mockImplementation(async (_taskId, _fields, options) => {
      await options!.internalOwnerTransition?.prepare(beforeEnvelope);
      fixture.order.push("authority:commit");
      return {
        before: beforeTask,
        after: afterTask,
        beforeEnvelope,
        afterEnvelope,
        appliedOperations: ["set:assignee"],
      };
    });

    const port: TaskMutationPublicationPort = {
      prepareOwnerTransitionIntent: vi.fn(async () => {
        fixture.order.push("publication:prepare:start");
        prepareEntered.resolve();
        await releasePrepare.promise;
        fixture.order.push("publication:prepare:end");
        return true;
      }),
      suppressTaskVersionForSession: vi.fn(async () => {
        fixture.order.push("publication:suppress");
      }),
      publishTaskMutation: vi.fn(async (input) => {
        fixture.order.push("publication:event:start");
        eventEntered.resolve();
        await releaseEvent.promise;
        fixture.order.push("publication:event:end");
        expect(input.deliver).toBe(false);
        return {
          warnings: [],
          evidence: {
            teamEvent: { appended: true },
            delivery: {
              attemptedRecipients: [],
              failedRecipients: [],
              recoveryRecordedFor: [],
              recoveryRecordFailedFor: [],
            },
          },
        };
      }),
      completeOwnerTransitionIntent: vi.fn(async () => {
        fixture.order.push("publication:complete");
        return [];
      }),
    };

    const mutation = applySemanticTaskUpdate(fixture.config.name, beforeTask.id, { assignee: "worker" }, {
      actor: "team-lead",
      actingSessionFile: "/tmp/team-lead.jsonl",
      actingMembershipId: "membership-1",
      expectedVersion: beforeTask.version,
      taskMetadata: metadata,
      taskCardProjector: card,
    }, port);

    await prepareEntered.promise;
    expect(fixture.order).toEqual(["lease:start", "publication:prepare:start"]);
    releasePrepare.resolve();

    await eventEntered.promise;
    expect(fixture.order).toEqual([
      "lease:start",
      "publication:prepare:start",
      "publication:prepare:end",
      "authority:commit",
      "lease:end",
      "publication:suppress",
      "publication:event:start",
    ]);
    releaseEvent.resolve();
    await mutation;

    expect(fixture.order).toEqual([
      "lease:start",
      "publication:prepare:start",
      "publication:prepare:end",
      "authority:commit",
      "lease:end",
      "publication:suppress",
      "publication:event:start",
      "publication:event:end",
      "publication:complete",
    ]);
  });

  it("suppresses an acting-Session no-op without event, delivery, or completion and keeps exact create replay silent", async () => {
    const noOpPort = silentPublicationPort();
    vi.spyOn(BeadsTaskStore.prototype, "updateWithResult").mockResolvedValue({
      before: beforeTask,
      after: beforeTask,
      beforeEnvelope,
      afterEnvelope: beforeEnvelope,
      appliedOperations: [],
    });

    const noOp = await applySemanticTaskUpdate(fixture.config.name, beforeTask.id, { status: "in_progress" }, {
      actor: "team-lead",
      actingSessionFile: "/tmp/team-lead-no-op.jsonl",
      actingMembershipId: "membership-1",
      expectedVersion: beforeTask.version,
      taskMetadata: metadata,
      taskCardProjector: card,
    }, noOpPort);
    expect(noOp.appliedOperations).toEqual([]);
    expect(noOpPort.suppressTaskVersionForSession).toHaveBeenCalledOnce();
    expect(noOpPort.suppressTaskVersionForSession).toHaveBeenCalledWith({
      teamName: fixture.config.name,
      recipient: "team-lead",
      sessionFile: "/tmp/team-lead-no-op.jsonl",
      task: card(beforeEnvelope),
    });
    expect(noOpPort.publishTaskMutation).not.toHaveBeenCalled();
    expect(noOpPort.completeOwnerTransitionIntent).not.toHaveBeenCalled();

    const replayPort = silentPublicationPort();
    vi.spyOn(BeadsTaskStore.prototype, "createWithResult").mockResolvedValue({
      task: beforeTask,
      taskEnvelope: beforeEnvelope,
      replayed: true,
    });
    const replay = await createTask(fixture.config.name, {
      title: beforeTask.title,
      description: beforeTask.description,
    }, replayPort);

    expect(replay).toMatchObject({
      changed: false,
      appliedOperations: [],
      deliveryDegraded: false,
      deliveryWarnings: [],
      publication: {
        teamEvent: { appended: false },
        delivery: {
          attemptedRecipients: [],
          failedRecipients: [],
          recoveryRecordedFor: [],
          recoveryRecordFailedFor: [],
        },
      },
    });
    expect(replayPort.prepareOwnerTransitionIntent).not.toHaveBeenCalled();
    expect(replayPort.suppressTaskVersionForSession).not.toHaveBeenCalled();
    expect(replayPort.publishTaskMutation).not.toHaveBeenCalled();
    expect(replayPort.completeOwnerTransitionIntent).not.toHaveBeenCalled();
  });
});
