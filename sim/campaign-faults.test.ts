import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { SimWorld } from "./world";
import { replayTrace } from "./replay";
import pidReuse from "./fixtures/traces/pid-reuse.json";
import type { WorldTrace } from "./trace-format";

it("replaces a dead actor even when another process occupies its old pid", async () => {
  const result = await replayTrace(pidReuse as WorldTrace, { seed: 42 });
  const workers = result.processes.filter(p => p.actor === "team-1/w1");
  expect(workers).toHaveLength(2);
  expect(workers[0]!.alive).toBe(false);
  expect(workers[1]!.alive).toBe(true);
  expect(workers[1]!.osBirthToken).not.toBe(workers[0]!.osBirthToken);
  expect(result.processes.some(p => p.pid === workers[0]!.pid && p.alive)).toBe(true);
});

it("throws after journal bytes are committed and leaves the accepted row readable", () => {
  const world = new SimWorld(3);
  try {
    world.createActor("team-1/lead");
    world.faults.set("journal", { source: "journal", mode: "commit_then_error" });
    const file = path.join(world.workspace.home, "team-events.jsonl");
    expect(() => world.enter("team-1/lead", () => {
      const fd = fs.openSync(file, "a");
      try { fs.writeSync(fd, '{"cursor":"1"}\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    })).toThrow("commit-then-error");
    expect(fs.readFileSync(file, "utf8")).toBe('{"cursor":"1"}\n');
    expect(world.history.filter(e => e.kind === "fault.effect")).toHaveLength(1);
    world.assertClean();
  } finally { world.dispose(); }
});

it("delays generation snapshots without blocking intervening world death", async () => {
  const world = new SimWorld(7);
  try {
    world.createActor("team-1/lead");
    const worker = world.processes.spawn("team-1/w1");
    world.faults.set("generation", { source: "generation", mode: "slow", delayMs: 7000 });
    let result: unknown;
    world.enqueue("team-1/lead", "sample", async () => { result = await world.envs.get("team-1/lead")!.process.generations!([worker.pid]); });
    world.scheduler.enqueue("death", () => world.killPid(worker.pid), { delay: 10 });
    await world.drain({ advanceTime: true });
    expect(world.processes.exists(worker.pid)).toBe(false);
    expect((result as Map<number, unknown>).get(worker.pid)).toMatchObject({ kind: "found" });
    expect(world.scheduler.now).toBeGreaterThanOrEqual(7000);
  } finally { world.dispose(); }
});
