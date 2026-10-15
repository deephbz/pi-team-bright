import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomicAsync } from "./atomic-json";
import { nodeHostEnv } from "../env/host-env";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function tempRoot(): string {
  const root = path.join(os.tmpdir(), `ptb-atomic-async-${process.pid}-${Date.now()}-${Math.random()}`);
  roots.push(root);
  return root;
}

describe("writeJsonAtomicAsync", () => {
  it("syncs the temporary file before rename and the directory after rename", async () => {
    const root = tempRoot();
    const target = path.join(root, "authority.json");
    const order: string[] = [];
    const open = nodeHostEnv.durableFs.open.bind(nodeHostEnv.durableFs);
    vi.spyOn(nodeHostEnv.durableFs, "open").mockImplementation(async (...args: Parameters<typeof nodeHostEnv.durableFs.open>) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        order.push(args[0] === root ? "directory-sync" : "file-sync");
        await sync();
      });
      return handle;
    });
    const rename = nodeHostEnv.durableFs.rename.bind(nodeHostEnv.durableFs);
    vi.spyOn(nodeHostEnv.durableFs, "rename").mockImplementation(async (...args) => {
      order.push("rename");
      return rename(...args);
    });

    await writeJsonAtomicAsync(target, { durable: true });

    expect(order).toEqual(["file-sync", "file-sync", "rename", "directory-sync"]);
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ durable: true });
  });

  it("removes the temporary file when replacement fails and preserves the old file", async () => {
    const root = tempRoot();
    const target = path.join(root, "authority.json");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(target, '{"old":true}');
    vi.spyOn(nodeHostEnv.durableFs, "rename").mockRejectedValueOnce(new Error("injected rename failure"));

    await expect(writeJsonAtomicAsync(target, { replacement: true })).rejects.toThrow("injected rename failure");

    expect(await fs.readFile(target, "utf8")).toBe('{"old":true}');
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
