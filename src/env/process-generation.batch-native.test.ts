import { afterEach, expect, it, vi } from "vitest";
import { probeProcessGenerations } from "./process-generation";
const f = vi.hoisted(() => ({ exec: vi.fn(), sync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: f.exec, spawnSync: f.sync }));
const platform = process.platform;
afterEach(() => { Object.defineProperty(process, "platform", { value: platform }); vi.resetAllMocks(); });
it.each([17, 50])("uses one bounded async helper for %i distinct macOS PIDs", async count => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const pids = Array.from({ length: count }, (_, i) => 100 + i);
  f.exec.mockImplementation((_file, args, options, callback) => {
    expect(args).toEqual(pids.map(String)); expect(options.timeout).toBe(2000);
    callback(null, args.map((pid: string) => `${pid} found 10:20 30:40`).join("\n"));
  });
  const results = await probeProcessGenerations([...pids, pids[0]]);
  expect(f.exec).toHaveBeenCalledOnce(); expect(f.sync).not.toHaveBeenCalled();
  expect([...results.values()].every(probe => probe.kind === "found")).toBe(true);
  expect(results.size).toBe(count);
});
