import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import {
  appendTaskEventFailureHint,
  readTaskEventFailureHintRecords,
  readTaskEventFailureHints,
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
