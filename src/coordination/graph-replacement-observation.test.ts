import { snapshotEntry } from "../../test/support/branch-observation";
import { describe, expect, it, vi } from "vitest";
import type { CanonicalTaskCard } from "../task-authority/task-domain";
import { taskVersionRef } from "../task-authority/task-version-ref";
import { CoordinationObservationService, taskProjectionRevision } from "./observation-service";
import type { CoordinationTaskReadOutcome } from "./queries";
import type { TeamEvent } from "./contracts";

function task(id: string, versionSeed = id): CanonicalTaskCard {
  return {
    id,
    title: id,
    goal: `Complete ${id}.`,
    current_context: "Ready.",
    status: "ready",
    assignee: "worker",
    needs: [],
    state: { kind: "ready" },
    attempts_started: 0,
    version: taskVersionRef(versionSeed),
    relations: [],
    dependency_state: { kind: "ready", active_blocker_ids: [] },
  };
}

function service(input: {
  current: CanonicalTaskCard[];
  event: TeamEvent;
  complete: boolean;
  readTasks?: (teamName: string, ids: readonly string[]) => Promise<CoordinationTaskReadOutcome[]>;
}) {
  const projection = vi.fn((events: readonly TeamEvent[], tasks: readonly CanonicalTaskCard[]) => ({
    kind: "projected" as const,
    changes: events.flatMap((event) => event.type === "task"
      ? tasks.filter((candidate) => candidate.id === event.ref.taskId).map((current) => ({
        taskId: current.id,
        changeKinds: ["status" as const],
        journalEntries: [],
        current,
      }))
      : []),
  }));
  const readTasks = vi.fn(input.readTasks ?? (async (_teamName: string, ids: readonly string[]) => ids.map((id) => {
    const current = input.current.find((candidate) => candidate.id === id);
    return current ? { kind: "found" as const, task: current } : undefined;
  })));
  const instance = new CoordinationObservationService({
    teamRuntime: {
      readRuntime: vi.fn(),
      readLeaderBinding: vi.fn(async () => ({
        teamName: "graph-team",
        epochId: "epoch",
        sessionFile: "/tmp/lead.jsonl",
        purpose: "fixture",
        members: [{ name: "team-lead", agentType: "lead", membershipId: "lead", sessionFile: "/tmp/lead.jsonl", isActive: true }],
        logicalWorkers: [],
      })),
    },
    taskStateDelivery: {
      completeTaskSet: () => input.complete,
      listTaskIds: vi.fn(async () => input.current.map((current) => current.id)),
      readTasks,
      readDeliveryEvidence: vi.fn(async () => ({ known: true, pending: false })),
    },
    alertActuation: { readInboxEvidence: vi.fn(async () => ({ known: true, pending: false })) },
    receivedAlerts: { readRecentReceivedAlerts: async () => ({ alerts: [], omitted: 0 }) },
  }, {
    projectNonterminalTaskIds: () => [],
    projectTaskChanges: projection,
  }, {
    readEvents: vi.fn((_team: string, options?: { afterCursor?: string }) => ({
      events: Number(options?.afterCursor ?? "0") < 1 ? [input.event] : [],
      cursor: "1", headCursor: "1", truncated: false, remaining: 0,
    })),
    readEventCursor: vi.fn(() => "1"),
  });
  instance.setBranchEntries("/tmp/lead.jsonl", [snapshotEntry("snapshot-entry", "graph-team", "epoch", "lead", input.current)]);
  return { instance, readTasks, projection };
}

describe("Coordination complete graph replacement", () => {
  it("surfaces a Herdr observation outage as a Team change without direct-alert duplication", async () => {
    const event: TeamEvent = { type: "alert", cursor: "1", at: "2026-08-13T00:00:00.000Z", alertId: "herdr-observation:outage-1", from: "team-lead", to: "team-lead", kind: "attention", text: "Herdr observation unavailable. Process verification continues." };
    const { instance } = service({ current: [], event, complete: true });
    await expect(instance.readTeamSync("/tmp/lead.jsonl", "updates", new AbortController().signal, "sync")).resolves.toMatchObject({
      kind: "updates", teamChanges: [{ kind: "lifecycle", text: event.text }], alerts: [], head: 1,
    });
  });
  it("advances across a removed historical Task event without hydrating the removed ID", async () => {
    const current = task("current");
    const removedVersion = taskVersionRef("removed-version");
    const event: TeamEvent = {
      type: "task",
      cursor: "1",
      ref: { taskId: "removed", version: removedVersion },
      change: "status",
      actor: "worker",
      at: "2026-08-13T00:00:00.000Z",
    };
    const { instance, readTasks, projection } = service({ current: [current], event, complete: true });

    const result = await instance.readTeamSync("/tmp/lead.jsonl", "updates", new AbortController().signal, "sync");
    expect(result).toEqual({ kind: "caught_up", head: 1, epochId: "epoch" });
    expect(readTasks).toHaveBeenCalledTimes(1);
    for (const call of readTasks.mock.calls) expect(call).toEqual(["graph-team", ["current"]]);
    expect(projection).toHaveBeenCalledWith([], [current]);
  });

  it("advances a retained-Task superseded-version event without projecting it as the current card", async () => {
    const current = task("retained", "retained-v2");
    const event: TeamEvent = {
      type: "task",
      cursor: "1",
      ref: { taskId: "retained", version: taskVersionRef("retained-v1") },
      change: "goal",
      actor: "team-lead",
      at: "2026-08-13T00:00:00.000Z",
    };
    const { instance, projection } = service({ current: [current], event, complete: true });

    const result = await instance.readTeamSync("/tmp/lead.jsonl", "updates", new AbortController().signal, "sync");
    expect(result).toEqual({ kind: "caught_up", head: 1, epochId: "epoch" });
    expect(projection).toHaveBeenCalledWith([], [current]);
  });

  it("still returns unavailable when a listed current graph Task cannot hydrate", async () => {
    const current = task("current");
    const event: TeamEvent = {
      type: "task",
      cursor: "1",
      ref: { taskId: "current", version: taskVersionRef(current.version) },
      change: "status",
      actor: "worker",
      at: "2026-08-13T00:00:00.000Z",
    };
    const { instance } = service({ current: [current], event, complete: true, readTasks: async () => [undefined] });

    await expect(instance.readTeamSync("/tmp/lead.jsonl", "updates", new AbortController().signal, "sync"))
      .resolves.toMatchObject({ kind: "unavailable", reason: "task_authority_unavailable", message: expect.stringContaining("could not be hydrated") });
  });
});
