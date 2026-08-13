import { describe, expect, it, vi } from "vitest";
import type { CanonicalTaskCard } from "../task-authority/task-domain";
import { taskVersionRef } from "../task-authority/task-version-ref";
import { CoordinationObservationService } from "./observation-service";
import type { CoordinationHiddenObservationProjection, CoordinationTaskReadOutcome } from "./queries";
import type { TeamEvent } from "./contracts";

function task(id: string, versionSeed = id): CanonicalTaskCard {
  return {
    id,
    title: id,
    goal: `Complete ${id}.`,
    current_context: "Ready.",
    status: "ready",
    assignee: "worker",
    model: "default",
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
  const hidden: CoordinationHiddenObservationProjection = {
    schema: "pi-teams-hidden-observation/1",
    teamEpochId: "epoch",
    exactSessionId: "/tmp/lead.jsonl",
    acknowledgedEntryId: "snapshot-entry",
    acknowledgedLineage: ["snapshot-entry"],
    teamEventCursor: "0",
    authorityRevisions: { task_projection: "prior", team_events: "0" },
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
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
        members: [],
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
  }, {
    projectNonterminalTaskIds: () => [],
    projectTaskChanges: projection,
  }, {
    readHidden: vi.fn(async () => ({ kind: "found" as const, projection: hidden })),
    commitHidden: vi.fn(async () => ({ kind: "committed" as const, projection: hidden })),
    readEvents: vi.fn(() => ({ events: [input.event], cursor: "1", headCursor: "1", truncated: false, remaining: 0 })),
    readEventCursor: vi.fn(() => "1"),
    waitEvents: vi.fn(),
    readFailureHints: vi.fn(() => ({ hints: [], cursor: "0", headCursor: "0" })),
  });
  instance.setBranchContext("/tmp/lead.jsonl", ["snapshot-entry"]);
  return { instance, readTasks, projection };
}

describe("Coordination complete graph replacement", () => {
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
    if (result.kind !== "updates") throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ kind: "updates", head: 1, taskChanges: [] });
    expect(readTasks).toHaveBeenCalledOnce();
    expect(readTasks).toHaveBeenCalledWith("graph-team", ["current"]);
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
    if (result.kind !== "updates") throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ kind: "updates", head: 1, taskChanges: [] });
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
