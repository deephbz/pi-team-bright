import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import {
  appendTaskEventFailureHint,
  readTaskEventFailureHintRecords,
  readTaskEventFailureHints,
  readTaskEventFailureHintsAfter,
  TaskEventFailureHintCursorAheadError,
} from "./task-event-failure-hints";
import { taskEventFailureHintPath, teamDir } from "./paths";

const teams: string[] = [];

afterEach(() => {
  for (const team of teams.splice(0)) fs.rmSync(teamDir(team), { recursive: true, force: true });
});

describe("Task event failure hints", () => {
  it("matches current epoch and Task versions and classifies exact actors", async () => {
    const teamName = `task-event-hints-${process.pid}-${Date.now()}`;
    teams.push(teamName);
    fs.mkdirSync(teamDir(teamName), { recursive: true });
    const currentVersion = taskVersionRef("current");
    const staleVersion = taskVersionRef("stale");
    await appendTaskEventFailureHint(teamName, {
      teamEpochId: "epoch-current",
      taskId: "task-1",
      taskVersion: currentVersion,
      actor: "team-lead",
      at: "2026-01-01T00:00:00.000Z",
    });
    await appendTaskEventFailureHint(teamName, {
      teamEpochId: "epoch-current",
      taskId: "task-1",
      taskVersion: currentVersion,
      actor: "worker",
      at: "2026-01-01T00:00:01.000Z",
    });
    await appendTaskEventFailureHint(teamName, {
      teamEpochId: "old-epoch",
      taskId: "task-1",
      taskVersion: currentVersion,
      actor: "external",
      at: "2026-01-01T00:00:02.000Z",
    });
    await appendTaskEventFailureHint(teamName, {
      teamEpochId: "epoch-current",
      taskId: "task-1",
      taskVersion: staleVersion,
      actor: "external",
      at: "2026-01-01T00:00:03.000Z",
    });
    fs.appendFileSync(taskEventFailureHintPath(teamName), "not-json\n");

    expect(readTaskEventFailureHintRecords(teamName)).toHaveLength(4);
    expect(readTaskEventFailureHints(teamName, {
      teamEpochId: "epoch-current",
      taskReferences: [{ taskId: "task-1", taskVersion: currentVersion }],
    })).toEqual([
      { hint: expect.objectContaining({ actor: "team-lead" }), actorKind: "team-lead" },
      { hint: expect.objectContaining({ actor: "worker" }), actorKind: "non-leader/external" },
    ]);
  });

  it("assigns ordered epoch-local cursors under concurrent append", async () => {
    const teamName = `task-event-hints-concurrent-${process.pid}-${Date.now()}`;
    teams.push(teamName);
    fs.mkdirSync(teamDir(teamName), { recursive: true });
    const version = taskVersionRef("concurrent");
    await Promise.all(Array.from({ length: 8 }, (_, index) => appendTaskEventFailureHint(teamName, {
      teamEpochId: "epoch-current",
      taskId: `task-${index}`,
      taskVersion: version,
      actor: "worker",
      at: `2026-01-01T00:00:0${index}.000Z`,
    })));
    expect(readTaskEventFailureHintRecords(teamName).map((hint) => hint.cursor)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("reads after a cursor, resets for a new epoch, and handles legacy records", async () => {
    const teamName = `task-event-hints-cursor-${process.pid}-${Date.now()}`;
    teams.push(teamName);
    fs.mkdirSync(teamDir(teamName), { recursive: true });
    const version = taskVersionRef("cursor");
    for (let index = 0; index < 3; index++) {
      await appendTaskEventFailureHint(teamName, {
        teamEpochId: "epoch-current",
        taskId: `task-${index}`,
        taskVersion: version,
        actor: "worker",
        at: `2026-01-01T00:00:0${index}.000Z`,
      });
    }
    const afterOne = readTaskEventFailureHintsAfter(teamName, "1", {
      teamEpochId: "epoch-current",
      taskReferences: [0, 1, 2].map((index) => ({ taskId: `task-${index}`, taskVersion: version })),
    });
    expect(afterOne).toMatchObject({ cursor: "3", headCursor: "3", hints: [{ hint: { cursor: "2" } }, { hint: { cursor: "3" } }] });
    expect(() => readTaskEventFailureHintsAfter(teamName, "4", {
      teamEpochId: "epoch-current",
      taskReferences: [],
    })).toThrow(TaskEventFailureHintCursorAheadError);

    const file = taskEventFailureHintPath(teamName);
    fs.appendFileSync(file, `${JSON.stringify({ schema: "pi-teams-task-event-failure-hint/1", teamEpochId: "epoch-current", taskId: "legacy-task", taskVersion: version, actor: "external", at: "2026-01-01T00:00:04.000Z" })}\n`);
    fs.appendFileSync(file, `${JSON.stringify({ schema: "pi-teams-task-event-failure-hint/1", teamEpochId: "epoch-current", taskId: "bad-cursor", taskVersion: version, actor: "external", at: "2026-01-01T00:00:05.000Z", cursor: "bad" })}\n`);
    expect(readTaskEventFailureHintRecords(teamName)).toHaveLength(4);
    expect(readTaskEventFailureHints(teamName, {
      teamEpochId: "epoch-current",
      taskReferences: [{ taskId: "legacy-task", taskVersion: version }],
    })[0]?.hint.cursor).toBeUndefined();

    await appendTaskEventFailureHint(teamName, {
      teamEpochId: "epoch-new",
      taskId: "new-task",
      taskVersion: version,
      actor: "team-lead",
      at: "2026-01-01T00:00:06.000Z",
    });
    expect(readTaskEventFailureHintsAfter(teamName, "0", {
      teamEpochId: "epoch-new",
      taskReferences: [{ taskId: "new-task", taskVersion: version }],
    })).toMatchObject({ cursor: "1", headCursor: "1", hints: [{ hint: { cursor: "1" } }] });
  });

  it("rejects malformed hints before persistence", async () => {
    const teamName = `task-event-hints-invalid-${process.pid}-${Date.now()}`;
    teams.push(teamName);
    fs.mkdirSync(teamDir(teamName), { recursive: true });
    await expect(appendTaskEventFailureHint(teamName, {
      teamEpochId: "epoch-current",
      taskId: "task-1",
      taskVersion: "bad-version" as any,
      actor: "team-lead",
      at: "2026-01-01T00:00:00.000Z",
    })).rejects.toThrow(/malformed/);
    expect(fs.existsSync(taskEventFailureHintPath(teamName))).toBe(false);
  });
});
