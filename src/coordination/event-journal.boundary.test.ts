import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as journal from "./event-journal";
import { configPath, teamDir, teamEventJournalPath } from "../utils/paths";

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

  it("preserves journal order across bounded continuation reads", async () => {
    await journal.appendTeamEvent(teamName, {
      type: "alert", alertId: "first", from: "team-lead", to: "worker", kind: "attention", text: "first",
    });
    await journal.appendTeamEvent(teamName, {
      type: "alert", alertId: "second", from: "team-lead", to: "worker", kind: "attention", text: "second",
    });

    expect(journal.readTeamEvents(teamName, { afterCursor: "0", limit: 1 })).toMatchObject({
      cursor: "1", headCursor: "2", truncated: true, remaining: 1,
    });
    expect(journal.readTeamEvents(teamName, { afterCursor: "1" })).toMatchObject({
      cursor: "2", headCursor: "2", truncated: false, remaining: 0,
      events: [expect.objectContaining({ alertId: "second", cursor: "2" })],
    });
  });

  it("appends a Task batch with consecutive cursors and one journal flush", async () => {
    const journalPath = teamEventJournalPath(teamName);
    const order: string[] = [];
    const realFsync = fs.fsyncSync.bind(fs);
    const realRename = fs.renameSync.bind(fs);
    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      order.push("fsync");
      return realFsync(fd);
    });
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      order.push("rename");
      return realRename(from, to);
    });
    const fullRead = vi.spyOn(fs, "readFileSync");
    const events = await journal.appendTaskEvidenceEvents(teamName, [
      { type: "task", ref: { taskId: "batch-a", version: "v_0000000000000001" }, actor: "team-lead", change: "created", taskEvidence: { kind: "created", text: "A" } },
      { type: "task", ref: { taskId: "batch-b", version: "v_0000000000000002" }, actor: "team-lead", change: "created", taskEvidence: { kind: "created", text: "B" } },
    ]);
    expect(events.map((event) => event.cursor)).toEqual(["1", "2"]);
    expect(fsync).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["fsync", "rename"]);
    expect(fullRead.mock.calls.filter(([file]) => file === journalPath)).toHaveLength(0);
    fullRead.mockRestore();
    rename.mockRestore();
    expect(journal.readTeamEvents(teamName).events).toHaveLength(2);
    fsync.mockRestore();
    expect(fs.existsSync(journalPath)).toBe(true);
  });

  it("drops only a torn unterminated tail before appending", async () => {
    const journalPath = teamEventJournalPath(teamName);
    await journal.appendTeamEvent(teamName, {
      type: "alert", alertId: "prior", from: "team-lead", to: "worker", kind: "attention", text: "prior",
    });
    fs.appendFileSync(journalPath, '{"cursor":"2","type":"task"');
    const appended = await journal.appendTeamEvent(teamName, {
      type: "alert", alertId: "after", from: "team-lead", to: "worker", kind: "attention", text: "after",
    });
    expect(appended.cursor).toBe("2");
    expect(journal.readTeamEvents(teamName).events.map((event) => event.cursor)).toEqual(["1", "2"]);
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

  it("splits one journal image into bounded continuation pages", () => {
    const events = Array.from({ length: 121 }, (_, index) => ({
      type: "task", cursor: String(index + 1), at: "2026-09-26T00:00:00Z",
      ref: { taskId: `task-${index}`, version: "v_0000000000000001" },
      actor: "worker", change: "status",
    }));
    fs.mkdirSync(path.dirname(teamEventJournalPath(teamName)), { recursive: true });
    fs.writeFileSync(teamEventJournalPath(teamName), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const pages = journal.readTeamEventPages(teamName, { afterCursor: "0" });
    expect(pages.map((page) => page.events.length)).toEqual([50, 50, 21]);
    expect(pages.map((page) => page.cursor)).toEqual(["50", "100", "121"]);
    expect(pages.map((page) => page.remaining)).toEqual([71, 21, 0]);
    expect(journal.readTeamEventPages(teamName, { afterCursor: "100" }).map((page) => page.cursor)).toEqual(["121"]);
  });

  it("keeps consumers on the canonical journal path", () => {
    for (const sourcePath of productionTypeScriptPaths(path.resolve("src"))) {
      expect(fs.readFileSync(sourcePath, "utf8")).not.toMatch(/utils\/team-events/);
    }
  });
});
