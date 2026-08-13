import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { createReadOnlyBeadsTaskAdapterFactory, projectNonterminalTaskIds, projectTaskChanges } from "./beads-task-adapter";
import { createDurableCoordinationQueries } from "../adapters/durable-coordination-queries";
import { DurableModelToolTeamPort } from "./durable-model-tool-port";
import { exactLeaderSessionId } from "./in-memory-team-port";
import { taskVersionRef } from "./task-version-ref";
import { TASK_METADATA_SCHEMA } from "../utils/beads";
import * as paths from "../utils/paths";
import * as teamEvents from "../coordination/event-journal";
import * as teams from "../utils/teams";
import { readHiddenObservationProjection } from "../utils/hidden-observation";
import { createDurableCoordinationNudgeStore } from "../adapters/durable-coordination-nudge-store";
import { DurableCoordinationHiddenObservation } from "../adapters/durable-coordination-hidden-observation";
import { CoordinationObservationService, createDurableCoordinationObservationStore } from "../coordination/observation-service";

const fixtures: string[] = [];
const readPort = {
  readTaskAuthorityRecordEnvelope: vi.fn(),
  readTaskAuthorityRecordEnvelopes: vi.fn(),
  listTaskIds: vi.fn(),
};
const readFactory = createReadOnlyBeadsTaskAdapterFactory(readPort);

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
    undefined,
  );
  const config = await teams.readConfig(name);
  config.logicalWorkers = [{ name: "worker", scope: "fixture scope" }];
  teams.writeConfigAtomic(paths.configPath(name), config);

  const queries = createDurableCoordinationQueries(readFactory);
  const hidden = new DurableCoordinationHiddenObservation();
  const port = new DurableModelToolTeamPort(
    { ensureWorker: vi.fn() } as any,
    undefined,
    readFactory,
    undefined,
    new CoordinationObservationService(queries, { projectNonterminalTaskIds, projectTaskChanges }, createDurableCoordinationObservationStore(hidden), undefined, createDurableCoordinationNudgeStore(hidden)),
  );
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

async function appendTaskEvent(
  name: string,
  id: string,
  change: "created" | "status" = "status",
  status: "open" | "closed" = "open",
) {
  return teamEvents.appendTeamEvent(name, {
    type: "task",
    ref: { taskId: id, version: taskVersionRef(`beads-${id}-${status}`) },
    change,
    actor: "worker",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  readPort.readTaskAuthorityRecordEnvelope.mockReset();
  readPort.readTaskAuthorityRecordEnvelopes.mockReset();
  readPort.listTaskIds.mockReset();
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
    const list = readPort.listTaskIds.mockResolvedValue([taskId]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockImplementation(async (_name: string, ids: readonly string[]) =>
      ids.map(() => current));

    await acknowledgeSnapshot(fixture);
    current = taskEnvelope(fixture.name, taskId, "closed");
    await appendTaskEvent(fixture.name, taskId, "status", "closed");

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
    const list = readPort.listTaskIds.mockResolvedValue([]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([]);
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
    const list = readPort.listTaskIds.mockResolvedValue([]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([]);
    await acknowledgeSnapshot(fixture);
    list.mockClear();
    hydrate.mockClear();
    hydrate.mockImplementation(async (_name: string, ids: readonly string[]) => ids.map((id) => taskEnvelope(fixture.name, id)));
    for (const taskId of taskIds) await appendTaskEvent(fixture.name, taskId);

    await expect(fixture.port.readTeamSync(fixture.leaderSessionId, "updates", new AbortController().signal, "many-events"))
      .resolves.toMatchObject({ kind: "updates", taskChanges: taskIds.map((taskId) => expect.objectContaining({ taskId })) });
    expect(list).not.toHaveBeenCalled();
    expect(hydrate).toHaveBeenCalledOnce();
    expect(hydrate).toHaveBeenCalledWith(fixture.name, taskIds);
  });

  it("projects Worker-only events without hydrating or listing Tasks", async () => {
    const fixture = await makeFixture();
    const list = readPort.listTaskIds.mockResolvedValue([]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([]);
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
    const list = readPort.listTaskIds.mockResolvedValue([]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([]);
    await acknowledgeSnapshot(fixture);
    list.mockClear();
    hydrate.mockClear();
    hydrate.mockRejectedValue(new Error("simulated event Task authority failure"));
    await appendTaskEvent(fixture.name, taskId);

    await expect(fixture.port.readTeamSync(fixture.leaderSessionId, "updates", new AbortController().signal, "failed-hydration"))
      .resolves.toMatchObject({ kind: "unavailable", reason: "task_authority_unavailable", message: "simulated event Task authority failure" });
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
    readPort.listTaskIds.mockResolvedValue([]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([]);
    await acknowledgeSnapshot(fixture);
    hydrate.mockClear();
    hydrate.mockRejectedValueOnce(new Error("temporary Task authority failure"));
    await appendTaskEvent(fixture.name, taskId);

    await expect(fixture.port.readTeamSync(fixture.leaderSessionId, "updates", new AbortController().signal, "first-retry"))
      .resolves.toMatchObject({ kind: "unavailable", reason: "task_authority_unavailable", message: "temporary Task authority failure" });
    hydrate.mockImplementation(async (_name: string, ids: readonly string[]) => ids.map((id) => taskEnvelope(fixture.name, id)));

    await expect(fixture.port.readTeamSync(fixture.leaderSessionId, "updates", new AbortController().signal, "second-retry"))
      .resolves.toMatchObject({ kind: "updates", head: 1, taskChanges: [{ taskId }] });
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(fixture.port.getPendingObservation(fixture.leaderSessionId)).toBeDefined();
  });

  it("rescans the complete authority after a port restart before applying event references", async () => {
    const fixture = await makeFixture();
    const baselineId = "restart-baseline-task";
    const eventId = "restart-event-task";
    const records = new Map([
      [baselineId, taskEnvelope(fixture.name, baselineId)],
      [eventId, taskEnvelope(fixture.name, eventId)],
    ]);
    const list = readPort.listTaskIds.mockResolvedValue([baselineId]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockImplementation(async (_name: string, ids: readonly string[]) => ids.map((id) => records.get(id)));
    await acknowledgeSnapshot(fixture);
    await teamEvents.appendTeamEvent(fixture.name, {
      type: "task",
      ref: { taskId: eventId, version: taskVersionRef(`beads-${eventId}-open`) },
      change: "created",
      actor: "team-lead",
    });

    list.mockResolvedValue([baselineId, eventId]);
    const resumedQueries = createDurableCoordinationQueries(readFactory);
    const resumedHidden = new DurableCoordinationHiddenObservation();
    const resumed = new DurableModelToolTeamPort(
      { ensureWorker: vi.fn() } as any,
      undefined,
      readFactory,
      undefined,
      new CoordinationObservationService(resumedQueries, { projectNonterminalTaskIds, projectTaskChanges }, createDurableCoordinationObservationStore(resumedHidden), undefined, createDurableCoordinationNudgeStore(resumedHidden)),
    );
    resumed.setLeaderSessionFile(fixture.leaderSessionId, fixture.sessionFile);
    resumed.setBranchContext(fixture.leaderSessionId, ["snapshot-entry"]);
    await expect(resumed.readTeamSync(fixture.leaderSessionId, "updates", new AbortController().signal, "restart-update"))
      .resolves.toMatchObject({ kind: "updates", taskChanges: [{ taskId: eventId, current: { id: eventId } }] });
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(hydrate).toHaveBeenLastCalledWith(fixture.name, [baselineId, eventId]);
    expect(resumed.getPendingObservation(fixture.leaderSessionId)).toBeDefined();
  });

  it("requires a fresh snapshot after a branch switch", async () => {
    const fixture = await makeFixture();
    const taskId = "branch-isolated-task";
    const list = readPort.listTaskIds.mockResolvedValue([taskId]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([taskEnvelope(fixture.name, taskId)]);
    await acknowledgeSnapshot(fixture, "branch-a");
    hydrate.mockClear();
    list.mockClear();
    fixture.port.setBranchContext(fixture.leaderSessionId, ["branch-b"]);

    await expect(fixture.port.readTeamSync(fixture.leaderSessionId, "updates", new AbortController().signal, "wrong-branch-update"))
      .resolves.toEqual({ kind: "snapshot_required", message: "Take a Team snapshot before requesting updates." });
    expect(list).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    expect(fixture.port.getPendingObservation(fixture.leaderSessionId)).toBeUndefined();
  });

  it("rescans Task authority after a quiet wait wakes without a Task event", async () => {
    const fixture = await makeFixture();
    const taskId = "quiet-rescan-task";
    let version = "quiet-v1";
    const list = readPort.listTaskIds.mockResolvedValue([taskId]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockImplementation(async () => {
      const current = taskEnvelope(fixture.name, taskId);
      return [{ ...current, task: { ...current.task, version } }];
    });
    await acknowledgeSnapshot(fixture);
    vi.spyOn(teamEvents, "waitForTeamEvents").mockImplementation(async () => {
      version = "quiet-v2";
      return {
        cursor: "1",
        headCursor: "1",
        events: [{ type: "worker", cursor: "1", worker: "worker", membershipId: "quiet-membership", phase: "failed", at: "2026-01-01T00:00:00.000Z" }],
        truncated: false,
        remaining: 0,
        timedOut: false,
      };
    });
    hydrate.mockClear();
    list.mockClear();

    await expect(fixture.port.readTeamSync(fixture.leaderSessionId, "updates", new AbortController().signal, "quiet-update"))
      .resolves.toMatchObject({ kind: "updates", head: 1, taskChanges: [{ taskId, changeKinds: ["progress"], current: { version: taskVersionRef("quiet-v2") } }] });
    expect(list).toHaveBeenCalledTimes(2);
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(hydrate).toHaveBeenLastCalledWith(fixture.name, [taskId]);
    expect(fixture.port.getPendingObservation(fixture.leaderSessionId)).toBeDefined();
  });
});
