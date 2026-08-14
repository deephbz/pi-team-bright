import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as journal from "./event-journal";
import * as legacyJournal from "../utils/team-events";
import { configPath, teamDir } from "../utils/paths";

function productionTypeScriptPaths(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptPaths(entryPath);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [entryPath] : [];
  });
}

describe("Coordination event-journal ownership boundary", () => {
  const teamName = `event-journal-boundary-${process.pid}-${Date.now()}`;

  beforeEach(() => {
    fs.mkdirSync(teamDir(teamName), { recursive: true });
    fs.writeFileSync(configPath(teamName), JSON.stringify({ name: teamName, members: [] }));
  });

  afterEach(() => {
    fs.rmSync(teamDir(teamName), { recursive: true, force: true });
  });

  it("keeps the legacy facade on the canonical ordered journal", async () => {
    await journal.appendTeamEvent(teamName, {
      type: "alert", alertId: "first", from: "team-lead", to: "worker", kind: "attention", text: "first",
    });
    await legacyJournal.appendTeamEvent(teamName, {
      type: "alert", alertId: "second", from: "team-lead", to: "worker", kind: "attention", text: "second",
    });

    expect(legacyJournal.readTeamEvents(teamName, { afterCursor: "0", limit: 1 })).toMatchObject({
      cursor: "1", headCursor: "2", truncated: true, remaining: 1,
    });
    expect(journal.readTeamEvents(teamName, { afterCursor: "1" })).toMatchObject({
      cursor: "2", headCursor: "2", truncated: false, remaining: 0,
      events: [expect.objectContaining({ alertId: "second", cursor: "2" })],
    });
  });

  it("projects latest per-Task activity in one newest-first read", async () => {
    await journal.appendTeamEvent(teamName, {
      type: "task", ref: { taskId: "task-a", version: "v_0000000000000001" }, actor: "team-lead", change: "created",
    });
    await journal.appendTeamEvent(teamName, {
      type: "task", ref: { taskId: "task-b", version: "v_0000000000000002" }, actor: "team-lead", change: "created",
    });
    await journal.appendTeamEvent(teamName, {
      type: "task", ref: { taskId: "task-a", version: "v_0000000000000003" }, actor: "worker", change: "status",
    });

    expect(journal.readTaskActivity(teamName)).toMatchObject({
      headCursor: "3",
      tasks: [
        {
          taskId: "task-a",
          cursor: "3",
          firstActivityAt: expect.any(String),
          lastActivityAt: expect.any(String),
        },
        {
          taskId: "task-b",
          cursor: "2",
          firstActivityAt: expect.any(String),
          lastActivityAt: expect.any(String),
        },
      ],
    });
  });

  it("keeps the historical utility path as a re-export only", () => {
    const facade = fs.readFileSync(path.resolve("src/utils/team-events.ts"), "utf8");
    expect(facade).toMatch(/^\/\*\* @deprecated Coordination owns the event journal/m);
    expect(facade).toContain('export * from "../coordination/event-journal";');

    for (const sourcePath of productionTypeScriptPaths(path.resolve("src"))) {
      if (sourcePath.endsWith("src/utils/team-events.ts")) continue;
      expect(fs.readFileSync(sourcePath, "utf8")).not.toMatch(/utils\/team-events/);
    }
  });
});
