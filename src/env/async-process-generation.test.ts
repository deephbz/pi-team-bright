import { expect, it, vi } from "vitest";
import { nodeHostEnv, runWithHostEnv, type GenerationProbe } from "./host-env";
import { readProcessGeneration, readProcessGenerations } from "./async-process-generation";

it.each([17, 50])("coalesces %i same-turn PID reads without blocking or a synchronous probe", async count => {
  let finish!: (value: Map<number, GenerationProbe>) => void;
  const generations = vi.fn(() => new Promise<Map<number, GenerationProbe>>(resolve => { finish = resolve; }));
  const host = { ...nodeHostEnv, process: { ...nodeHostEnv.process, generations } };
  await runWithHostEnv(host, async () => {
    const pids = Array.from({ length: count }, (_, i) => 100 + i);
    const reads = Promise.all([...pids, pids[0]].map(readProcessGeneration));
    const batch = readProcessGenerations(pids);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(generations).toHaveBeenCalledOnce(); expect(generations).toHaveBeenCalledWith(pids);
    finish(new Map(pids.map(pid => [pid, { kind: "found", generation: { pid, osBirthToken: String(pid), bootId: "boot" } }])));
    expect((await reads).every(probe => probe.kind === "found")).toBe(true);
    expect((await batch).size).toBe(count);
  });
});

it("does not share observations across hosts or reuse a completed batch", async () => {
  const left = vi.fn(async () => new Map<number, GenerationProbe>([[42, { kind: "absent" }]]));
  const right = vi.fn(async () => new Map<number, GenerationProbe>([[42, { kind: "unknown", reason: "generation_helper_missing" }]]));
  const host = (generations: typeof left) => ({ ...nodeHostEnv, process: { ...nodeHostEnv.process, generations } });
  const a = host(left), b = host(right);
  expect(await Promise.all([runWithHostEnv(a, () => readProcessGeneration(42)), runWithHostEnv(b, () => readProcessGeneration(42))]))
    .toEqual([{ kind: "absent" }, { kind: "unknown", reason: "generation_helper_missing" }]);
  await runWithHostEnv(a, () => readProcessGeneration(42));
  expect(left).toHaveBeenCalledTimes(2); expect(right).toHaveBeenCalledOnce();
});

it("starts a fresh probe after a fence even while the prior batch is pending", async () => {
  const finish: Array<(value: Map<number, GenerationProbe>) => void> = [];
  const generations = vi.fn(() => new Promise<Map<number, GenerationProbe>>(resolve => finish.push(resolve)));
  await runWithHostEnv({ ...nodeHostEnv, process: { ...nodeHostEnv.process, generations } }, async () => {
    const before = readProcessGeneration(42);
    await Promise.resolve(); // First batch has started. Enter a later fence.
    const after = readProcessGeneration(42);
    await Promise.resolve();
    expect(generations).toHaveBeenCalledTimes(2);
    finish[1](new Map([[42, { kind: "found", generation: { pid: 42, osBirthToken: "successor", bootId: "boot" } }]]));
    finish[0](new Map([[42, { kind: "absent" }]]));
    expect(await before).toEqual({ kind: "absent" });
    expect(await after).toMatchObject({ kind: "found", generation: { osBirthToken: "successor" } });
  });
});

it("keeps omitted or failed batch evidence unknown and rejects invalid PIDs without probing", async () => {
  const generations = vi.fn(async () => new Map<number, GenerationProbe>());
  await runWithHostEnv({ ...nodeHostEnv, process: { ...nodeHostEnv.process, generations } }, async () => {
    expect(await readProcessGeneration(0)).toEqual({ kind: "unknown", reason: "invalid_pid" });
    expect(generations).not.toHaveBeenCalled();
    expect(await readProcessGeneration(42)).toEqual({ kind: "unknown", reason: "generation_batch_unavailable" });
    generations.mockRejectedValueOnce(new Error("transport failed"));
    expect(await readProcessGeneration(42)).toEqual({ kind: "unknown", reason: "generation_batch_unavailable" });
  });
});
