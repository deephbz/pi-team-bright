import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskFile, TeamConfig } from "./models";
import { configPath, teamDir } from "./paths";
import {
  InvalidTeamSnapshotContinuationError,
  TeamEventCursorAheadError,
  appendTeamEvent,
  hydrateTeamSyncTasks,
  pageTeamCurrentProjection,
  projectTeamCurrentState,
  readTeamEvents,
} from "./team-events";

describe("Team event cursor and pagination contract", () => {
  const teamName = `event-page-${process.pid}-${Date.now()}`;

  beforeEach(() => {
    fs.mkdirSync(teamDir(teamName), { recursive: true });
    fs.writeFileSync(configPath(teamName), JSON.stringify({ name: teamName, members: [] }));
  });

  afterEach(() => {
    fs.rmSync(teamDir(teamName), { recursive: true, force: true });
  });

  async function appendAlert(index: number) {
    return appendTeamEvent(teamName, {
      type: "alert",
      alertId: `alert-${index}`,
      from: "team-lead",
      to: "worker",
      kind: "attention",
      text: `alert ${index}`,
    });
  }

  it("batches requested and event-referenced Task hydration into one authority read", async () => {
    const readTasks = vi.fn(async () => []);
    await hydrateTeamSyncTasks([
      { type: "task", cursor: "1", ref: { authorityId: "beads", taskId: "event-task", version: "v1" }, change: "created", actor: "team-lead", at: "2026-01-01T00:00:00.000Z" },
      { type: "alert", cursor: "2", alertId: "alert-1", from: "team-lead", to: "worker", kind: "attention", text: "Review", taskRef: { taskId: "alert-task" }, at: "2026-01-01T00:00:00.000Z" },
    ], ["requested-task", "event-task"], readTasks);

    expect(readTasks).toHaveBeenCalledTimes(1);
    expect(readTasks).toHaveBeenCalledWith(["requested-task", "event-task", "alert-task"]);
  });

  it("refuses a cursor beyond journal head instead of returning a lower cursor", async () => {
    await appendAlert(1);
    expect(() => readTeamEvents(teamName, { afterCursor: "9" })).toThrow(TeamEventCursorAheadError);
    try {
      readTeamEvents(teamName, { afterCursor: "9" });
    } catch (error) {
      expect(error).toMatchObject({ requestedCursor: "9", headCursor: "1" });
    }
  });

  it("bounds event pages and advances only to the last returned event until caught up", async () => {
    for (let index = 1; index <= 5; index++) await appendAlert(index);

    const first = readTeamEvents(teamName, { afterCursor: "0", limit: 2 });
    expect(first).toMatchObject({ cursor: "2", headCursor: "5", truncated: true, remaining: 3 });
    expect(first.events.map((event) => event.cursor)).toEqual(["1", "2"]);

    const second = readTeamEvents(teamName, { afterCursor: first.cursor, limit: 2 });
    expect(second).toMatchObject({ cursor: "4", headCursor: "5", truncated: true, remaining: 1 });
    expect(second.events.map((event) => event.cursor)).toEqual(["3", "4"]);

    const final = readTeamEvents(teamName, { afterCursor: second.cursor, limit: 2 });
    expect(final).toMatchObject({ cursor: "5", headCursor: "5", truncated: false, remaining: 0 });
    expect(final.events.map((event) => event.cursor)).toEqual(["5"]);
  });

  it("lets task_ids select Task-relevant Task and Alert events without Worker telemetry crowding the page", async () => {
    for (let index = 1; index <= 50; index++) {
      await appendTeamEvent(teamName, {
        type: "worker",
        worker: "reviewer",
        membershipId: "membership-current",
        phase: "failed",
      });
    }
    await appendTeamEvent(teamName, {
      type: "task",
      ref: { authorityId: "authority", taskId: "task-requested", version: "v2" },
      change: "relation",
      actor: "team-lead",
    });
    await appendTeamEvent(teamName, {
      type: "alert",
      alertId: "alert-task",
      from: "team-lead",
      to: "reviewer",
      taskRef: { taskId: "task-requested", version: "v2" },
      kind: "clarification",
      text: "Resolve the blocker.",
    });

    const relevant = readTeamEvents(teamName, { afterCursor: "0", taskIds: ["task-requested"], limit: 2 });
    expect(relevant.events.map((event) => event.type)).toEqual(["task", "alert"]);
    expect(relevant).toMatchObject({ cursor: "52", headCursor: "52", truncated: false, remaining: 0 });
  });

  it("returns bounded snapshot pages with a head-pinned continuation", () => {
    const config: TeamConfig = {
      name: teamName,
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "lead-session",
      members: [],
    };
    const tasks = [1, 2, 3].map((index): TaskFile => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      description: "goal",
      acceptanceCriteria: "verified",
      status: "open",
      relations: [],
      version: `v${index}`,
      provenance: { authority: "beads", teamName },
    }));
    const projection = projectTeamCurrentState(config, tasks);
    const first = pageTeamCurrentProjection(projection, { headCursor: "7", limit: 2 });
    expect(first).toMatchObject({ offset: 0, totalItems: 3, truncated: true });
    expect(first.projection.tasks.map((task) => task.id)).toEqual(["task-1", "task-2"]);

    const final = pageTeamCurrentProjection(projection, {
      headCursor: "7",
      limit: 2,
      continuation: first.continuation,
    });
    expect(final).toMatchObject({ offset: 2, totalItems: 3, truncated: false });
    expect(final.projection.tasks.map((task) => task.id)).toEqual(["task-3"]);
    expect(() => pageTeamCurrentProjection(projection, {
      headCursor: "8",
      limit: 2,
      continuation: first.continuation,
    })).toThrow(InvalidTeamSnapshotContinuationError);
  });
});
