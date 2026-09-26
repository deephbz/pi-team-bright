import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableGraphTaskAuthority } from "../../src/adapters/durable-graph-task-authority";
import { DurableTaskMutationPublication } from "../../src/adapters/durable-task-mutation-publication";
import { DurableGraphTaskOrchestration } from "../../src/task-authority/graph-orchestration";
import { readTeamEvents } from "../../src/coordination/event-journal";
import { CoordinationObservationService } from "../../src/coordination/observation-service";
import { projectNonterminalTaskIds, projectTaskChanges } from "../../src/model-tool-contract/beads-task-adapter";
import { readGraphRevisionRetirement } from "../../src/utils/graph-revision-retirement";
import { configPath, graphTaskAuthorityPath, teamDir } from "../../src/utils/paths";
import { readCurrentTaskDeliveries, TaskChangeDelivery } from "../../src/utils/task-delivery";
import { writeConfigAtomic } from "../../src/utils/teams";
import type { TeamConfig } from "../../src/team-authority/contracts";

const teams: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const team of teams.splice(0)) fs.rmSync(teamDir(team), { force: true, recursive: true });
});

function fixture(suffix: string) {
  const teamName = `formal-publication-${suffix}-${process.pid}-${Date.now()}`;
  teams.push(teamName);
  const sessionFile = path.join(teamDir(teamName), "worker-session.jsonl");
  const config: TeamConfig = {
    name: teamName, description: "Adversarial graph publication fixture.", createdAt: 0,
    leadAgentId: "lead", leadSessionId: "lead-session", epochId: `epoch-${suffix}`,
    logicalWorkers: [{ name: "worker", scope: "Execute the Task." }],
    members: [{
      membershipId: "membership-worker", agentId: "agent-worker", name: "worker", agentType: "teammate",
      joinedAt: 0, sessionFile, cwd: process.cwd(), subscriptions: [],
    }],
  };
  fs.mkdirSync(teamDir(teamName), { recursive: true });
  writeConfigAtomic(configPath(teamName), config);
  const authority = new DurableGraphTaskAuthority();
  const publication = new DurableTaskMutationPublication();
  const orchestration = new DurableGraphTaskOrchestration(authority, publication, publication, publication);
  return { teamName, sessionFile, authority, publication, orchestration };
}

function graph(operationId: string, goal: string, expectedGraphVersion?: `g_${string}`) {
  return {
    operationId,
    ...(expectedGraphVersion ? { expectedGraphVersion } : {}),
    tasks: [{ key: "task", title: "Task", goal, assignee: "worker" }],
  };
}

describe("authority commit and publication windows", () => {
  it("refuses delivery when a fenced Team loses its graph authority snapshot", async () => {
    const { teamName, orchestration } = fixture("missing-authority");
    const applied = await orchestration.applyGraph(teamName, graph("initial", "Complete work."));
    expect(applied.kind).toBe("applied");
    expect(await readCurrentTaskDeliveries(teamName, "worker")).toHaveLength(1);
    fs.unlinkSync(graphTaskAuthorityPath(teamName));
    await expect(readCurrentTaskDeliveries(teamName, "worker")).rejects.toThrow(/Graph authority.*missing/);
  });

  it("rechecks a selected delivery after graph replacement at the final send boundary", async () => {
    const { teamName, sessionFile, authority, publication, orchestration } = fixture("late-replace");
    const first = await orchestration.applyGraph(teamName, graph("initial", "Initial work."));
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") return;
    const [pending] = await readCurrentTaskDeliveries(teamName, "worker");
    const sendMessage = vi.fn();
    let replaced = false;
    const replacing = new DurableGraphTaskOrchestration(authority, publication, publication, {
      retireGraphRevision: async () => { throw new Error("injected fence failure"); },
    });
    const delivery = new TaskChangeDelivery({ sendMessage, appendEntry: vi.fn() }, {
      teamName, recipient: "worker", sessionFile,
      membership: {
        currentRecipient: async () => ({ membershipId: "membership-worker" }),
        withCurrentRecipient: async <T>(_input: unknown, action: () => Promise<T>) => {
          if (!replaced) {
            replaced = true;
            const result = await replacing.applyGraph(teamName, graph("replacement", "Revised work.", first.graphVersion));
            expect(result.kind).toBe("applied");
          }
          return action();
        },
      },
      reconcile: async () => 0, reconcileOwnerOutbox: async () => [], reconcileReady: async () => [],
    });
    await delivery.start([]);
    expect(replaced).toBe(true);
    expect((await authority.readTask(teamName, "task"))?.version).not.toBe(pending.ref.version);
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain(pending.ref.version);
    delivery.stop();
  });

  it("does not present an old Task version after a committed replacement with failed retirement", async () => {
    const { teamName, sessionFile, authority, publication, orchestration } = fixture("retirement-failure");
    const first = await orchestration.applyGraph(teamName, graph("initial", "Do the original work."));
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") return;
    const [pending] = await readCurrentTaskDeliveries(teamName, "worker");
    expect(pending.ref.taskId).toBe("task");

    const failedRetirement = {
      retireGraphRevision: async () => { throw new Error("injected retirement failure"); },
    };
    const replacing = new DurableGraphTaskOrchestration(authority, publication, publication, failedRetirement);
    const second = await replacing.applyGraph(teamName, graph("replace", "Do revised work.", first.graphVersion));
    expect(second.kind).toBe("applied");
    if (second.kind !== "applied") return;
    expect(second.deliveryWarnings).toEqual(expect.arrayContaining([expect.stringContaining("retirement failed")]));
    expect((await authority.readTask(teamName, "task"))?.version).not.toBe(pending.ref.version);

    const sendMessage = vi.fn();
    const delivery = new TaskChangeDelivery({ sendMessage, appendEntry: vi.fn() }, {
      teamName, recipient: "worker", sessionFile,
      membership: {
        currentRecipient: async () => ({ membershipId: "membership-worker" }),
        withCurrentRecipient: async <T>(_input: unknown, action: () => Promise<T>) => action(),
      },
      reconcile: async () => 0, reconcileOwnerOutbox: async () => [], reconcileReady: async () => [],
    });
    await delivery.start([]);
    expect((await readCurrentTaskDeliveries(teamName, "worker")).some(record =>
      record.ref.version === pending.ref.version)).toBe(false);
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ changes: [expect.objectContaining({ ref: pending.ref })] }),
    }));
    delivery.stop();
  });

  it("keeps the newer retirement fence when an older graph apply is replayed", async () => {
    const { teamName, orchestration } = fixture("old-replay");
    const firstInput = graph("first", "Initial goal.");
    const first = await orchestration.applyGraph(teamName, firstInput);
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") return;
    const second = await orchestration.applyGraph(teamName, graph("second", "Revised goal.", first.graphVersion));
    expect(second.kind).toBe("applied");
    if (second.kind !== "applied") return;
    const before = await readGraphRevisionRetirement(teamName);
    const replay = await orchestration.applyGraph(teamName, firstInput);
    expect(replay).toMatchObject({ kind: "applied", replayed: true, deliveryWarnings: [] });
    const after = await readGraphRevisionRetirement(teamName);
    expect(after).toEqual(before);
    expect((await readCurrentTaskDeliveries(teamName, "worker")).every(delivery =>
      delivery.ref.version === second.tasks[0].version)).toBe(true);
  });

  it("projects current Task state when an older committed event arrives late", async () => {
    const { teamName, authority, publication, orchestration } = fixture("overlap");
    let unblock!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>(resolve => { unblock = resolve; });
    const atRetirement = new Promise<void>(resolve => { entered = resolve; });
    const delayed = new DurableGraphTaskOrchestration(authority, publication, publication, {
      retireGraphRevision: async input => {
        entered();
        await hold;
        await publication.retireGraphRevision(input);
      },
    });
    const olderPending = delayed.applyGraph(teamName, graph("older", "Initial goal."));
    await atRetirement;
    const olderGraphVersion = (await authority.trace(teamName)).graphRevisions.at(-1)!.version;
    const newer = await orchestration.applyGraph(teamName, graph("newer", "Revised goal.", olderGraphVersion));
    expect(newer.kind).toBe("applied");
    if (newer.kind !== "applied") { unblock(); await olderPending; return; }
    unblock();
    const older = await olderPending;
    expect(older.kind).toBe("applied");
    if (older.kind !== "applied") throw new Error(older.kind);
    const fence = await readGraphRevisionRetirement(teamName);
    expect(fence?.current.graphVersion).toBe(newer.graphVersion);
    expect(fence?.current.currentTasks).toEqual([{ taskId: "task", taskVersion: newer.tasks[0].version }]);
    const taskEvents = readTeamEvents(teamName).events.filter(event => event.type === "task");
    expect(taskEvents.at(-1)?.ref.version).toBe(older.tasks[0].version);
    const leadSession = path.join(teamDir(teamName), "lead.jsonl");
    const hidden = {
      schema: "pi-teams-hidden-observation/1" as const,
      teamEpochId: `epoch-overlap`, exactSessionId: leadSession,
      acknowledgedEntryId: "snapshot-entry", acknowledgedLineage: ["snapshot-entry"],
      teamEventCursor: "0", authorityRevisions: { team_events: "0", task_projection: "prior" },
      updatedAt: "2026-09-26T00:00:00.000Z",
    };
    const observation = new CoordinationObservationService({
      teamRuntime: {
        readRuntime: async () => null,
        readLeaderBinding: async () => ({ teamName, epochId: "epoch-overlap", sessionFile: leadSession, members: [], logicalWorkers: [] }),
      },
      taskStateDelivery: {
        completeTaskSet: () => true,
        listTaskIds: async () => (await authority.readTasks(teamName)).map(task => task.id),
        readTasks: async (_team, ids) => {
          const cards = await authority.readTasks(teamName, ids);
          return ids.map(id => {
            const task = cards.find(card => card.id === id);
            return task ? { kind: "found" as const, task } : undefined;
          });
        },
        readDeliveryEvidence: async () => ({ known: true, pending: false }),
      },
      alertActuation: { readInboxEvidence: async () => ({ known: true, pending: false }) },
    }, { projectNonterminalTaskIds, projectTaskChanges }, {
      readHidden: async () => ({ kind: "found", projection: hidden }),
      commitHidden: async () => ({ kind: "committed", projection: hidden }),
      readEvents: (name, options) => readTeamEvents(name, options),
      readEventCursor: () => String(taskEvents.length),
      waitEvents: vi.fn(),
      readFailureHints: () => ({ hints: [], cursor: "0", headCursor: "0" }),
    });
    observation.setBranchContext(leadSession, ["snapshot-entry"]);
    const updates = await observation.readTeamSync(leadSession, "updates", new AbortController().signal, "sync");
    expect(updates.kind).toBe("updates");
    if (updates.kind !== "updates") return;
    expect(updates.taskChanges).toHaveLength(1);
    expect(updates.taskChanges[0].current.version).toBe(newer.tasks[0].version);
    expect(JSON.stringify(updates.taskChanges)).not.toContain(older.tasks[0].version);
  });

  it("repairs a missing Task event on exact current graph replay", async () => {
    const { teamName, publication, orchestration } = fixture("event-replay");
    const publish = publication.publishTaskMutation.bind(publication);
    vi.spyOn(publication, "publishTaskMutation")
      .mockImplementationOnce(async () => { throw new Error("injected failure before event append"); })
      .mockImplementation(input => publish(input));
    const input = graph("apply", "Complete the Task.");
    const committed = await orchestration.applyGraph(teamName, input);
    expect(committed.kind).toBe("applied");
    if (committed.kind !== "applied") return;
    expect(committed.deliveryWarnings).toEqual(expect.arrayContaining([expect.stringContaining("publication failed")]));
    expect(readTeamEvents(teamName).events.filter(event => event.type === "task")).toHaveLength(0);

    const replay = await orchestration.applyGraph(teamName, input);
    expect(replay).toMatchObject({ kind: "applied", replayed: true });
    expect(readTeamEvents(teamName).events.filter(event => event.type === "task"
      && event.ref.taskId === "task" && event.ref.version === committed.tasks[0].version)).toHaveLength(1);
  });
});
