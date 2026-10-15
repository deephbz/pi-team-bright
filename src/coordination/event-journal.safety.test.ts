import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as journal from "./event-journal";
import { configPath, teamDir, teamEventJournalPath } from "../utils/paths";

const names: string[] = [];
function fixture() {
  const name = `journal-safety-${process.pid}-${names.length}`;
  names.push(name);
  fs.mkdirSync(teamDir(name), { recursive: true });
  fs.writeFileSync(configPath(name), JSON.stringify({ name, members: [] }));
  return { name, file: teamEventJournalPath(name) };
}
const input = (id: string) => ({
  type: "alert" as const, alertId: id, from: "team-lead", to: "worker", kind: "attention" as const, text: id,
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const name of names.splice(0)) fs.rmSync(teamDir(name), { recursive: true, force: true });
});

it("preserves committed bytes when recovering a torn UTF-8 suffix", async () => {
  const { name, file } = fixture();
  await journal.appendTeamEvent(name, input("prior"));
  const prior = fs.readFileSync(file);
  fs.appendFileSync(file, Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xe2])]));
  expect((await journal.appendTeamEvent(name, input("after"))).cursor).toBe("2");
  expect(fs.readFileSync(file).subarray(0, prior.length).equals(prior)).toBe(true);
  expect(journal.readTeamEvents(name).events.map((event) => event.cursor)).toEqual(["1", "2"]);
});

it("allocates after the last event across trailing empty lines", async () => {
  const { name, file } = fixture();
  await journal.appendTeamEvent(name, input("prior"));
  fs.appendFileSync(file, "\n");
  expect(journal.readTeamEvents(name).headCursor).toBe("1");
  expect((await journal.appendTeamEvent(name, input("after"))).cursor).toBe("2");
  expect(journal.readTeamEvents(name).events.map((event) => event.cursor)).toEqual(["1", "2"]);
});

it.each(["empty", "torn"])("finds the prior cursor across multiple chunks of %s tail lines", async (tail) => {
  const { name, file } = fixture();
  await journal.appendTeamEvent(name, { ...input("prior"), text: "€".repeat(4000) });
  const prior = fs.readFileSync(file);
  fs.appendFileSync(file, "\n".repeat(9000));
  if (tail === "torn") fs.appendFileSync(file, Buffer.from([0xe2]));
  expect((await journal.appendTeamEvent(name, input("after"))).cursor).toBe("2");
  expect(fs.readFileSync(file).subarray(0, prior.length).equals(prior)).toBe(true);
  expect(journal.readTeamEvents(name).events.map((event) => event.cursor)).toEqual(["1", "2"]);
});

it("does not recover a terminated malformed line or a whitespace line", async () => {
  const { name, file } = fixture();
  await journal.appendTeamEvent(name, input("prior"));
  fs.appendFileSync(file, " \n");
  const before = fs.readFileSync(file);
  await expect(journal.appendTeamEvent(name, input("after"))).rejects.toThrow(/invalid JSON/);
  expect(fs.readFileSync(file)).toEqual(before);
});

it("does not truncate a torn suffix when its preceding committed line is malformed", async () => {
  const { name, file } = fixture();
  await journal.appendTeamEvent(name, input("prior"));
  fs.appendFileSync(file, "!\n\n{");
  const before = fs.readFileSync(file);
  await expect(journal.appendTeamEvent(name, input("after"))).rejects.toThrow(/invalid JSON/);
  expect(fs.readFileSync(file)).toEqual(before);
});

it("completes short tail reads before allocating the next cursor", async () => {
  const { name, file } = fixture();
  await journal.appendTeamEvent(name, input("prior"));
  const originalOpen = fsp.open.bind(fsp);
  let reads = 0;
  vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === file && args[1] === "r+") {
      const originalRead = handle.read.bind(handle);
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        reads++;
        return originalRead(buffer, offset, Math.min(length, 17), position);
      }) as typeof handle.read;
    }
    return handle;
  });
  expect((await journal.appendTeamEvent(name, input("after"))).cursor).toBe("2");
  expect(reads).toBeGreaterThan(1);
  expect(journal.readTeamEvents(name).events.map((event) => event.cursor)).toEqual(["1", "2"]);
});

it("fails without truncating a valid unterminated row when newline write makes no progress", async () => {
  const { name, file } = fixture();
  await journal.appendTeamEvent(name, input("prior"));
  const before = fs.readFileSync(file).subarray(0, -1);
  fs.writeFileSync(file, before);
  const originalOpen = fsp.open.bind(fsp);
  vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === file && args[1] === "r+") {
      handle.write = (async (buffer: Buffer) => ({ bytesWritten: 0, buffer })) as typeof handle.write;
    }
    return handle;
  });
  await expect(journal.appendTeamEvent(name, input("after"))).rejects.toThrow(/no progress/);
  expect(fs.readFileSync(file)).toEqual(before);
});

it("rejects same-inode prefix corruption plus growth in both warm and cold reads", async () => {
  const { name, file } = fixture();
  await journal.appendTeamEvent(name, input("prior"));
  const prior = fs.readFileSync(file);
  const inode = fs.statSync(file).ino;
  journal.readTeamEvents(name);
  prior[0] = 0x21;
  fs.writeFileSync(file, Buffer.concat([prior, Buffer.from(`${JSON.stringify({ ...input("after"), cursor: "2", at: "2026-10-15T00:00:00Z" })}\n`)]));
  expect(fs.statSync(file).ino).toBe(inode);
  const cold = fixture();
  fs.mkdirSync(path.dirname(cold.file), { recursive: true });
  fs.copyFileSync(file, cold.file);
  expect(() => journal.readTeamEvents(cold.name)).toThrow(/invalid JSON/);
  expect(() => journal.readTeamEvents(name)).toThrow(/invalid JSON/);
});

it.each([false, true])("revalidates an early prefix rewrite beyond a tail anchor (malformed=%s)", async (malformed) => {
  const { name, file } = fixture();
  await journal.appendTeamEvents(name, [input("first"), { ...input("large"), text: "x".repeat(9000) }]);
  journal.readTeamEvents(name);
  const prior = fs.readFileSync(file);
  if (malformed) prior[0] = 0x21;
  else prior.write("other", prior.indexOf('"alertId":"first"') + '"alertId":"'.length);
  fs.writeFileSync(file, Buffer.concat([prior, Buffer.from(`${JSON.stringify({ ...input("after"), cursor: "3", at: "2026-10-15T00:00:00Z" })}\n`)]));
  if (malformed) expect(() => journal.readTeamEvents(name)).toThrow(/invalid JSON/);
  else {
    expect(journal.readTeamEvents(name).events[0]).toMatchObject({ alertId: "other" });
    expect(journal.readTeamEvents(name).headCursor).toBe("3");
    await journal.appendTeamEvent(name, input("fourth"));
    expect(journal.readTeamEvents(name).headCursor).toBe("4");
    expect(journal.readTeamEvents(name).events[0]).toMatchObject({ alertId: "other" });
  }
});

it("persists every batch row across legal native short writes before syncing and returning receipts", async () => {
  const { name, file } = fixture();
  // FileHandle.writeFile loops inside Node. Intercept its native write boundary,
  // not writeFile's all-or-error contract. Restrict the fault to this journal fd.
  const binding = (process as unknown as { binding(name: string): {
    writeBuffer(fd: number, buffer: Buffer, offset: number, length: number, ...rest: unknown[]): unknown;
  } }).binding("fs");
  const originalWrite = binding.writeBuffer;
  const originalOpen = fsp.open.bind(fsp);
  let journalFd = -1;
  let writes = 0;
  let synced = false;
  vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === file && args[1] === "a") {
      journalFd = handle.fd;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        journalFd = -1;
        await close();
      });
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        expect(journal.readTeamEvents(name).events.map((event) => event.cursor)).toEqual(["1", "2"]);
        await sync();
        synced = true;
      });
    }
    return handle;
  });
  binding.writeBuffer = function (fd, buffer, offset, length, ...rest) {
    if (fd === journalFd) { writes++; length = Math.min(length, 31); }
    return originalWrite.call(this, fd, buffer, offset, length, ...rest);
  };
  try {
    const receipts = await journal.appendTeamEvents(name, [input("first"), input("second")]);
    expect(writes).toBeGreaterThan(2);
    expect(synced).toBe(true);
    expect(receipts.map((event) => event.cursor)).toEqual(["1", "2"]);
    expect(journal.readTeamEvents(name).events).toEqual(receipts);
  } finally {
    binding.writeBuffer = originalWrite;
  }
});
