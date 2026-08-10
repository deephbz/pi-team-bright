import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  order: [] as string[],
  append: vi.fn(),
  enqueue: vi.fn(),
  prepare: vi.fn(),
  recovery: vi.fn(),
  suppress: vi.fn(),
  complete: vi.fn(),
  hint: vi.fn(),
  readConfig: vi.fn(),
}));

vi.mock("../utils/team-events", () => ({ appendTaskEvidenceEvent: calls.append }));
vi.mock("../utils/task-event-failure-hints", () => ({ appendTaskEventFailureHint: calls.hint }));
vi.mock("../utils/teams", () => ({ readConfig: calls.readConfig }));
vi.mock("../utils/task-delivery", () => ({
  enqueueTaskChangeForRecipient: calls.enqueue,
  prepareOwnerTransitionIntent: calls.prepare,
  recordTaskDeliveryRecovery: calls.recovery,
  suppressTaskVersionForSession: calls.suppress,
  completeOwnerTransitionIntent: calls.complete,
}));

import { DurableTaskMutationPublication } from "./durable-task-mutation-publication";
import type { TaskMutationCoordinates, TaskMutationPublicationInput } from "../model-tool-contract/beads-authority-adapter";
import type { TaskCard } from "../model-tool-contract/task-domain";

const before: TaskCard & TaskMutationCoordinates = {
  id: "task-1",
  title: "Publish mutation",
  goal: "Preserve publication order.",
  status: "in_progress",
  assignee: "alice",
  current_context: "Ready.",
  version: "v_1111111111111111",
};
const after: TaskCard & TaskMutationCoordinates = {
  ...before,
  assignee: "bob",
  status: "blocked",
  version: "v_2222222222222222",
};

function input(overrides: Partial<TaskMutationPublicationInput> = {}): TaskMutationPublicationInput {
  return {
    teamName: "publication-team",
    before,
    after,
    created: false,
    kind: "assigned",
    actor: "team-lead",
    taskEventEvidence: [{ kind: "assignment", text: "Assigned to bob." }],
    deliver: true,
    taskCard: after,
    ...overrides,
  };
}

describe("DurableTaskMutationPublication", () => {
  beforeEach(() => {
    calls.order.length = 0;
    vi.clearAllMocks();
    calls.append.mockImplementation(async () => { calls.order.push("event"); });
    calls.enqueue.mockImplementation(async (_team: string, _task: TaskCard, recipient: string) => {
      calls.order.push(`delivery:${recipient}`);
    });
    calls.recovery.mockImplementation(async () => { calls.order.push("recovery"); });
    calls.hint.mockImplementation(async () => { calls.order.push("failed-event-hint"); });
    calls.readConfig.mockResolvedValue({ epochId: "epoch-1" });
    calls.prepare.mockResolvedValue(true);
    calls.suppress.mockResolvedValue(undefined);
    calls.complete.mockResolvedValue([]);
  });

  it("publishes the serial Team event before prior-owner and new-owner delivery", async () => {
    const result = await new DurableTaskMutationPublication().publishTaskMutation(input());

    expect(calls.order).toEqual(["event", "delivery:alice", "delivery:bob"]);
    expect(result).toEqual({
      warnings: [],
      evidence: {
        teamEvent: { appended: true },
        delivery: {
          attemptedRecipients: ["alice", "bob"],
          failedRecipients: [],
          recoveryRecordedFor: [],
          recoveryRecordFailedFor: [],
        },
      },
    });
  });

  it("records an rc.10 failed-event hint before serial delivery and inline recovery", async () => {
    calls.append.mockImplementationOnce(async () => {
      calls.order.push("event");
      throw new Error("event unavailable");
    });
    calls.enqueue.mockImplementation(async (_team: string, _task: TaskCard, recipient: string) => {
      calls.order.push(`delivery:${recipient}`);
      if (recipient === "alice") throw new Error("spool unavailable");
    });

    const result = await new DurableTaskMutationPublication().publishTaskMutation(input());

    expect(calls.order).toEqual(["event", "failed-event-hint", "delivery:alice", "recovery", "delivery:bob"]);
    expect(calls.hint).toHaveBeenCalledWith("publication-team", {
      teamEpochId: "epoch-1",
      taskId: "task-1",
      taskVersion: after.version,
      actor: "team-lead",
      at: expect.any(String),
    });
    expect(calls.recovery).toHaveBeenCalledWith(expect.objectContaining({
      teamName: "publication-team",
      taskId: "task-1",
      taskVersion: after.version,
      recipients: ["alice"],
      changeKind: "ownership_lost",
      recordedAt: expect.any(String),
      reason: "enqueue-failed",
      taskProjection: after,
    }));
    expect(result.warnings).toEqual([
      "Task task-1 committed but its Team event was not recorded: event unavailable",
      "Task task-1 committed but delivery enqueue for alice failed",
    ]);
    expect(result.evidence.delivery).toEqual({
      attemptedRecipients: ["alice", "bob"],
      failedRecipients: ["alice"],
      recoveryRecordedFor: ["alice"],
      recoveryRecordFailedFor: [],
    });
  });

  it("preserves exact warnings and continues after event, hint, enqueue, and recovery failures", async () => {
    calls.append.mockImplementationOnce(async () => {
      calls.order.push("event");
      throw new Error("event unavailable");
    });
    calls.hint.mockImplementationOnce(async () => {
      calls.order.push("failed-event-hint");
      throw new Error("hint unavailable");
    });
    calls.enqueue.mockImplementationOnce(async (_team: string, _task: TaskCard, recipient: string) => {
      calls.order.push(`delivery:${recipient}`);
      throw new Error("spool unavailable");
    });
    calls.recovery.mockImplementationOnce(async () => {
      calls.order.push("recovery");
      throw new Error("recovery unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await new DurableTaskMutationPublication().publishTaskMutation(input());

    expect(calls.order).toEqual([
      "event",
      "failed-event-hint",
      "delivery:alice",
      "recovery",
      "delivery:bob",
    ]);
    expect(result.warnings).toEqual([
      "Task task-1 committed but its Team event was not recorded: event unavailable",
      "Task task-1 committed but failed-event hint persistence also failed: hint unavailable",
      "Task task-1 committed but delivery enqueue for alice failed",
      "Task task-1 committed but delivery enqueue for alice failed; recovery evidence could not be persisted",
    ]);
    expect(result.evidence.delivery).toEqual({
      attemptedRecipients: ["alice", "bob"],
      failedRecipients: ["alice"],
      recoveryRecordedFor: [],
      recoveryRecordFailedFor: ["alice"],
    });
    expect(warn).toHaveBeenCalledWith("[pi-teams] Task task-1 committed but failed-event hint persistence also failed: hint unavailable");
  });

  it("delegates lease-time preparation, suppression, and completion without retained state", async () => {
    const bridge = new DurableTaskMutationPublication();
    await bridge.prepareOwnerTransitionIntent({ operationId: "op-1", teamName: "publication-team", before, afterOwner: "bob" });
    await bridge.suppressTaskVersionForSession({ teamName: "publication-team", recipient: "alice", sessionFile: "/tmp/alice.jsonl", task: before });
    await bridge.completeOwnerTransitionIntent({ teamName: "publication-team", operationId: "op-1", task: after });

    expect(calls.prepare).toHaveBeenCalledWith({ operationId: "op-1", teamName: "publication-team", before, afterOwner: "bob" });
    expect(calls.suppress).toHaveBeenCalledWith("publication-team", "alice", "/tmp/alice.jsonl", before);
    expect(calls.complete).toHaveBeenCalledWith("publication-team", "op-1", after, {});
    expect(Object.keys(bridge)).toEqual([]);
  });
});

describe("Task mutation publication import fence", () => {
  it("keeps Task authority free of concrete publication imports and injects one factory", () => {
    const authority = fs.readFileSync(path.join(process.cwd(), "src/model-tool-contract/beads-authority-adapter.ts"), "utf8");
    const taskAdapter = fs.readFileSync(path.join(process.cwd(), "src/model-tool-contract/beads-task-adapter.ts"), "utf8");
    const bridge = fs.readFileSync(path.join(process.cwd(), "src/adapters/durable-task-mutation-publication.ts"), "utf8");
    const durablePort = fs.readFileSync(path.join(process.cwd(), "src/model-tool-contract/durable-model-tool-port.ts"), "utf8");
    const extension = fs.readFileSync(path.join(process.cwd(), "extensions/index.ts"), "utf8");

    expect(authority).not.toMatch(/from ["'][^"']*(?:team-events|task-delivery|task-event-failure-hints)["']/);
    expect(taskAdapter).not.toMatch(/from ["'][^"']*(?:task-delivery|task-event-failure-hints)["']/);
    expect(bridge).toMatch(/from ["'][^"']*team-events["']/);
    expect(bridge).toMatch(/from ["'][^"']*task-delivery["']/);
    expect(bridge).toMatch(/from ["'][^"']*task-event-failure-hints["']/);
    expect(durablePort).toContain("new DurableModelToolTaskApplication(bindings, taskAdapterFactory)");
    expect(extension).toContain("const taskAuthorityTeam = new DurableTaskAuthorityTeam()");
    expect(extension).toContain("createPublishingBeadsTaskAdapterFactory(new DurableTaskMutationPublication(), taskAuthorityTeam)");
    expect(extension).toContain("taskAdapterFactory(binding.teamName, binding.member.name)");
  });
});
