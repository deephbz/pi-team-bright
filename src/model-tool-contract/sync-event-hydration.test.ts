import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as authority from "./beads-authority-adapter";
import { DurableModelToolTeamPort } from "./durable-model-tool-port";
import { exactLeaderSessionId } from "./in-memory-team-port";
import { MODEL_TOOL_IMPLEMENTATION_VERSION } from "./model-tool-constants";
import { taskVersionRef } from "./task-version-ref";
import { TASK_METADATA_SCHEMA } from "../utils/beads";
import * as paths from "../utils/paths";
import * as teamEvents from "../utils/team-events";
import * as teams from "../utils/teams";
import { readHiddenObservationProjection } from "../utils/hidden-observation";

const fixtures: string[] = [];

function fixtureName(): string {
  const name = `sync-event-hydration-${process.pid}-${Date.now()}-${fixtures.length}`;
  fixtures.push(name);
  return name;
}

async function makeFixture() {
  const name = fixtureName();
  const sessionFile = `/tmp/${name}-lead.jsonl`;
  await teams.createTeam(
    name,
    sessionFile,
    "lead-agent",
    "event hydration fixture",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    MODEL_TOOL_IMPLEMENTATION_VERSION,
  );
  const config = await teams.readConfig(name);
  config.logicalWorkers = [{ name: "worker", scope: "fixture scope" }];
  teams.writeConfigAtomic(paths.configPath(name), config);

  const port = new DurableModelToolTeamPort({ ensureWorker: vi.fn() } as any);
  const leaderSessionId = exactLeaderSessionId(`session-${name}`);
  port.setLeaderSessionFile(leaderSessionId, sessionFile);
  return { name, sessionFile, port, leaderSessionId };
}

function taskEnvelope(name: string, id: string, status: "open" | "closed" = "open") {
  const version = `beads-${id}-${status}`;
  return {
    task: {
      id,
      title: `${id} canonical title`,
      description: "Compatibility description must not become the goal.",
      acceptanceCriteria: "Compatibility acceptance criteria.",
      status,
      relations: [],
      version,
      provenance: { authority: "beads" as const, teamName: name },
    },
    taskMetadata: {
      schema: TASK_METADATA_SCHEMA,
      goal: `${id} canonical goal`,
      current_context: `${id} canonical context`,
    },
  };
}

async function acknowledgeSnapshot(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  entryId = "snapshot-entry",
) {
  const { port, leaderSessionId } = fixture;
  port.setBranchContext(leaderSessionId, [entryId]);
  await expect(port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "snapshot-call"))
    .resolves.toMatchObject({ kind: "snapshot", head: 0 });
  port.setPendingObservationResult(leaderSessionId, { kind: "snapshot" });
  await expect(port.acknowledgePendingObservationAsync(leaderSessionId, entryId, [entryId])).resolves.toBe(true);
}

async function appendTaskEvent(name: string, id: string, change: "created" | "status" = "status") {
  return teamEvents.appendTeamEvent(name, {
    type: "task",
    ref: { taskId: id, version: taskVersionRef(`event-${id}`) },
    change,
    actor: "worker",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of fixtures.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
});

describe("DurableModelToolTeamPort event-directed Task hydration", () => {
  it("keeps a snapshot baseline complete, then projects a canonical close update", async () => {
    const fixture = await makeFixture();
    const taskId = "close-task";
    let current = taskEnvelope(fixture.name, taskId, "open");
    const list = vi.spyOn(authority, "listTaskIds").mockResolvedValue([taskId]);
    const hydrate = vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockImplementation(async (_name, ids) =>
      ids.map(() => current));

    await acknowledgeSnapshot(fixture);
    current = taskEnvelope(fixture.name, taskId, "closed");
    await appendTaskEvent(fixture.name, taskId);

    await expect(fixture.port.readTeamSync(fixture.leaderSessionId, "updates", new AbortController().signal, "close-update"))
      .resolves.toMatchObject({
        kind: "updates",
        head: 1,
        taskChanges: [{ taskId, changeKinds: ["status"], current: { id: taskId, status: "closed", goal: `${taskId} canonical goal` } }],
      });
    expect(list).toHaveBeenCalledOnce();
    expect(hydrate).toHaveBeenLastCalledWith(fixture.name, [taskId]);
  });

  it("hydrates an event Task that the Team list does not return", async () => {
    const fixture = await makeFixture();
    const taskId = "event-only-task";
    const list = vi.spyOn(authority, "listTaskIds").mockResolvedValue([]);
    const hydrate = vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockResolvedValue([]);
    await acknowledgeSnapshot(fixture);
    list.mockClear();
    hydrate.mockClear();
    hydrate.mockResolvedValue([taskEnvelope(fixture.name, taskId)]);
    await appendTaskEvent(fixture.name, taskId, "created");

    await expect(fixture.port.readTeamSync(fixture.leaderSessionId, "updates", new AbortController().signal, "event-only-update"))
      .resolves.toMatchObject({ kind: "updates", taskChanges: [{ taskId, current: { id: taskId, title: `${taskId} canonical title` } }] });
    expect(list).not.toHaveBeenCalled();
    expect(hydrate).toHaveBeenCalledOnce();
    expect(hydrate).toHaveBeenCalledWith(fixture.name, [taskId]);
  });

  it("hydrates many Task events with one canonical batch authority read", async () => {
    const fixture = await makeFixture();
    const taskIds = ["event-task-a", "event-task-b", "event-task-c"];
    const list = vi.spyOn(authority, "listTaskIds").mockResolvedValue([]);
    const hydrate = vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockResolvedValue([]);
    await acknowledgeSnapshot(fixture);
    list.mockClear();
    hydrate.mockClear();
    hydrate.mockImplementation(async (_name, ids) => ids.map((id) => taskEnvelope(fixture.name, id)));
    for (const taskId of taskIds) await appendTaskEvent(fixture.name, taskId);

    await expect(fixture.port.readTeamSync(fixture.leaderSessionId, "updates", new AbortController().signal, "many-events"))
      .resolves.toMatchObject({ kind: "updates", taskChanges: taskIds.map((taskId) => expect.objectContaining({ taskId })) });
    expect(list).not.toHaveBeenCalled();
    expect(hydrate).toHaveBeenCalledOnce();
    expect(hydrate).toHaveBeenCalledWith(fixture.name, taskIds);
  });

  it("projects Worker-only events without hydrating or listing Tasks", async () => {
    const fixture = await makeFixture();
    const list = vi.spyOn(authority, "listTaskIds").mockResolvedValue([]);
    const hydrate = vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockResolvedValue([]);
    await acknowledgeSnapshot(fixture);
    list.mockClear();
    hydrate.mockClear();
    await teamEvents.appendTeamEvent(fixture.name, {
      type: "worker",
      worker: "worker",
      membershipId: "worker-membership",
      phase: "session_bound",
      generation: { membershipId: "worker-membership", pid: process.pid, startedAt: Date.now() },
    });

    await expect(fixture.port.readTeamSync(fixture.leaderSessionId, "updates", new AbortController().signal, "worker-event"))
      .resolves.toMatchObject({ kind: "updates", workerChanges: [{ worker: "worker", kind: "connected" }], taskChanges: [] });
    expect(list).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("does not stage or advance the watermark when event Task hydration fails", async () => {
    const fixture = await makeFixture();
    const taskId = "failed-hydration-task";
    const list = vi.spyOn(authority, "listTaskIds").mockResolvedValue([]);
    const hydrate = vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockResolvedValue([]);
    await acknowledgeSnapshot(fixture);
    list.mockClear();
    hydrate.mockClear();
    hydrate.mockRejectedValue(new Error("simulated event Task authority failure"));
    await appendTaskEvent(fixture.name, taskId);

    await expect(fixture.port.readTeamSync(fixture.leaderSessionId, "updates", new AbortController().signal, "failed-hydration"))
      .rejects.toThrow("simulated event Task authority failure");
    expect(fixture.port.getPendingObservation(fixture.leaderSessionId)).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    const config = await teams.readConfig(fixture.name);
    await expect(readHiddenObservationProjection(fixture.name, {
      teamEpochId: config.epochId!,
      exactSessionId: fixture.sessionFile,
      branchLineage: ["snapshot-entry"],
    })).resolves.toMatchObject({ kind: "found", projection: { teamEventCursor: "0" } });
  });

  it("returns the event on retry after Task hydration recovers", async () => {
    const fixture = await makeFixture();
    const taskId = "retry-hydration-task";
    vi.spyOn(authority, "listTaskIds").mockResolvedValue([]);
    const hydrate = vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockResolvedValue([]);
    await acknowledgeSnapshot(fixture);
    hydrate.mockClear();
    hydrate.mockRejectedValueOnce(new Error("temporary Task authority failure"));
    await appendTaskEvent(fixture.name, taskId);

    await expect(fixture.port.readTeamSync(fixture.leaderSessionId, "updates", new AbortController().signal, "first-retry"))
      .rejects.toThrow("temporary Task authority failure");
    hydrate.mockImplementation(async (_name, ids) => ids.map((id) => taskEnvelope(fixture.name, id)));

    await expect(fixture.port.readTeamSync(fixture.leaderSessionId, "updates", new AbortController().signal, "second-retry"))
      .resolves.toMatchObject({ kind: "updates", head: 1, taskChanges: [{ taskId }] });
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(fixture.port.getPendingObservation(fixture.leaderSessionId)).toBeDefined();
  });
});
