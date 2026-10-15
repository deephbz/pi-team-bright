import fs from "node:fs";
import fsp from "node:fs/promises";
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
    const realOpen = fsp.open.bind(fsp);
    const realRename = fsp.rename.bind(fsp);
    const open = vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const realSync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        order.push("fsync");
        return realSync();
      });
      return handle;
    });
    const rename = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      order.push("rename");
      return realRename(from, to);
    });
    const fullRead = vi.spyOn(fs, "readFileSync");
    const events = await journal.appendTaskEvidenceEvents(teamName, [
      { type: "task", ref: { taskId: "batch-a", version: "v_0000000000000001" }, actor: "team-lead", change: "created", taskEvidence: { kind: "created", text: "A" } },
      { type: "task", ref: { taskId: "batch-b", version: "v_0000000000000002" }, actor: "team-lead", change: "created", taskEvidence: { kind: "created", text: "B" } },
    ]);
    expect(events.map((event) => event.cursor)).toEqual(["1", "2"]);
    expect(order).toEqual(["fsync", "rename"]);
    expect(fullRead.mock.calls.filter(([file]) => file === journalPath)).toHaveLength(0);
    fullRead.mockRestore();
    rename.mockRestore();
    expect(journal.readTeamEvents(teamName).events).toHaveLength(2);
    open.mockRestore();
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
    const clone = vi.spyOn(globalThis, "structuredClone");
    const pages = journal.readTeamEventPages(teamName, { afterCursor: "0" });
    expect(clone.mock.calls.filter(([value]) => Array.isArray(value))).toEqual([]);
    clone.mockRestore();
    expect(pages.map((page) => page.events.length)).toEqual([50, 50, 21]);
    expect(pages.map((page) => page.cursor)).toEqual(["50", "100", "121"]);
    expect(pages.map((page) => page.remaining)).toEqual([71, 21, 0]);
    expect(journal.readTeamEventPages(teamName, { afterCursor: "100" }).map((page) => page.cursor)).toEqual(["121"]);
  });

  it.each(["events", "pages"] as const)("keeps cached %s events immutable across warm and appended reads", async (boundary) => {
    await journal.appendTaskEvidenceEvents(teamName, [
      { type: "task", ref: { taskId: "original", version: "v_0000000000000001" }, actor: "team-lead", change: "created", taskEvidence: { kind: "created", text: "original evidence" } },
      { type: "task", ref: { taskId: "second", version: "v_0000000000000002" }, actor: "team-lead", change: "created", taskEvidence: { kind: "created", text: "second evidence" } },
    ]);
    const read = () => boundary === "events"
      ? [journal.readTeamEvents(teamName, { limit: 1 })]
      : journal.readTeamEventPages(teamName, { limit: 1 });
    const original = read();
    const disk = fs.readFileSync(teamEventJournalPath(teamName), "utf8");
    const returned = structuredClone(original);
    const event = returned[0].events[0];
    const nested = original[0].events[0] as any;
    if (nested.type !== "task" || !("taskEvidence" in nested)) throw new Error("Expected Task evidence fixture.");
    expect(() => { nested.cursor = "900"; }).toThrow(TypeError);
    expect(() => { nested.ref.taskId = "caller"; }).toThrow(TypeError);
    expect(() => { nested.ref.version = "v_0000000000000900"; }).toThrow(TypeError);
    expect(() => { nested.taskEvidence.text = "caller evidence"; }).toThrow(TypeError);
    expect(read()).toEqual(returned);
    expect(journal.readTeamEventCursor(teamName)).toBe("2");
    expect(fs.readFileSync(teamEventJournalPath(teamName), "utf8")).toBe(disk);
    await journal.appendTeamEvent(teamName, { type: "alert", alertId: "third", from: "team-lead", to: "worker", kind: "attention", text: "third" });
    const afterAppend = journal.readTeamEvents(teamName);
    expect(afterAppend.events[0]).toEqual(event);
    expect(journal.readTeamEventCursor(teamName)).toBe("3");
    expect(() => { (afterAppend.events.at(-1) as any).text = "caller changed appended record"; }).toThrow(TypeError);
  });

  it("reads a 10,000-event paging loop from one journal image", () => {
    const journalPath = teamEventJournalPath(teamName);
    const lines = Array.from({ length: 10_000 }, (_, index) => JSON.stringify({
      type: "alert", cursor: String(index + 1), at: "2026-09-26T00:00:00Z",
      alertId: `alert-${index + 1}`, from: "team-lead", to: "worker", kind: "attention", text: "event",
    }));
    const image = `${lines.join("\n")}\n`;
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, image);
    const read = vi.spyOn(fs, "readSync");
    const clone = vi.spyOn(globalThis, "structuredClone");

    let cursor = "0";
    let pages = 0;
    do {
      const page = journal.readTeamEvents(teamName, { afterCursor: cursor, limit: 100 });
      expect(page.events).toHaveLength(100);
      expect(page.events.every((event) => Object.isFrozen(event))).toBe(true);
      pages++;
      cursor = page.cursor;
      if (!page.truncated) break;
    } while (true);

    expect(pages).toBe(100);
    expect(clone.mock.calls.filter(([value]) => Array.isArray(value))).toEqual([]);
    clone.mockRestore();
    expect(cursor).toBe("10000");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(expect.any(Number), expect.any(Buffer), 0, Buffer.byteLength(image), 0);
    read.mockRestore();
  });

  it("reads only appended bytes and rejects non-monotonic appended cursors", async () => {
    const journalPath = teamEventJournalPath(teamName);
    await journal.appendTeamEvent(teamName, {
      type: "alert", alertId: "first", from: "team-lead", to: "worker", kind: "attention", text: "first",
    });
    journal.readTeamEvents(teamName);
    const appended = `${JSON.stringify({ cursor: "2", type: "alert", alertId: "second", from: "team-lead", to: "worker", kind: "attention", text: "second", at: "2026-09-26T00:00:00Z" })}\n`;
    fs.appendFileSync(journalPath, appended);
    const read = vi.spyOn(fs, "readSync");
    expect(journal.readTeamEvents(teamName).events).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(expect.any(Number), expect.any(Buffer), 0, Buffer.byteLength(appended), expect.any(Number));
    read.mockRestore();

    fs.appendFileSync(journalPath, `${JSON.stringify({ cursor: "2", type: "alert", alertId: "duplicate", from: "team-lead", to: "worker", kind: "attention", text: "duplicate", at: "2026-09-26T00:00:00Z" })}\n`);
    expect(() => journal.readTeamEvents(teamName)).toThrow(/cursors must increase monotonically/);
  });

  it("revalidates replaced and truncated journals and fails closed on a torn suffix", async () => {
    const journalPath = teamEventJournalPath(teamName);
    await journal.appendTeamEvent(teamName, {
      type: "alert", alertId: "first", from: "team-lead", to: "worker", kind: "attention", text: "first",
    });
    expect(journal.readTeamEvents(teamName).headCursor).toBe("1");

    const replacement = `${JSON.stringify({ cursor: "7", type: "alert", alertId: "replacement", from: "team-lead", to: "worker", kind: "attention", text: "replacement", at: "2026-09-26T00:00:00Z" })}\n`;
    const replacementPath = `${journalPath}.replacement`;
    fs.writeFileSync(replacementPath, replacement);
    fs.renameSync(replacementPath, journalPath);
    expect(journal.readTeamEvents(teamName).headCursor).toBe("7");
    fs.writeFileSync(journalPath, `${JSON.stringify({ cursor: "1", type: "alert", alertId: "truncated", from: "team-lead", to: "worker", kind: "attention", text: "truncated", at: "2026-09-26T00:00:00Z" })}\n`);
    expect(journal.readTeamEvents(teamName).headCursor).toBe("1");

    fs.appendFileSync(journalPath, '{"cursor":"2","type":"alert"');
    expect(() => journal.readTeamEvents(teamName)).toThrow();
    const recovered = await journal.appendTeamEvent(teamName, {
      type: "alert", alertId: "recovered", from: "team-lead", to: "worker", kind: "attention", text: "recovered",
    });
    expect(recovered.cursor).toBe("2");
    expect(journal.readTeamEvents(teamName).events.map((event) => event.cursor)).toEqual(["1", "2"]);
  });

  it("keeps consumers on the canonical journal path", () => {
    for (const sourcePath of productionTypeScriptPaths(path.resolve("src"))) {
      expect(fs.readFileSync(sourcePath, "utf8")).not.toMatch(/utils\/team-events/);
    }
  });
});
