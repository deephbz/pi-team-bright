import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import fc from "fast-check";
import { hostEnv } from "../src/env/host-env";
import { Entropy } from "./entropy";
import { Scheduler } from "./scheduler";
import { SimWorld } from "./world";
import { ProcessTable } from "./process-table";
import { createSimSession } from "./session";
import { replayTrace } from "./replay";
import type { WorldTrace } from "./trace-format";

const trace: WorldTrace = {
  version: 1, id: "synthetic-pid-reuse", source: "synthetic", assumptions: ["A1", "A2", "A7"], setup: { ptbVersion: "baseline", teams: [] },
  steps: [
    { at: 0, step: { kind: "herdr.agentState", pane: "pane-worker", state: "working" } },
    { at: 5, step: { kind: "os.kill", who: { team: "team", actor: "w1" }, signal: "SIGKILL" } },
    { at: 5, step: { kind: "os.pidReuse", dead: { team: "team", actor: "w1" }, newcomer: "unrelated" } },
    { at: 10, step: { kind: "herdr.restart" } },
    { at: 20, step: { kind: "human.closePane", pane: "pane-worker" } },
  ],
};

function prepare(world: SimWorld): void {
  world.createActor("lead");
  world.herdr.spawn("pane-worker");
  world.herdr.onStart = undefined;
  world.herdr.start("pane-worker", "team/w1");
  world.enter("lead", () => {
    hostEnv().clock.setTimeout(() => world.record({ kind: "test.sample", value: JSON.parse(JSON.stringify(world.herdr.list())) }), 5);
    hostEnv().clock.setTimeout(() => world.record({ kind: "test.sample", value: JSON.parse(JSON.stringify(world.herdr.list())) }), 5);
  });
}

describe("single-queue deterministic world", () => {
  it("replays WorldTrace decisions and enabled sets identically, including a recorded choice log", async () => {
    const setup = ({ world }: { world: SimWorld }) => prepare(world);
    const first = await replayTrace(trace, { setup });
    const second = await replayTrace(trace, { setup });
    expect(second).toEqual(first);
    expect(await replayTrace(trace, { setup, choices: first.choices })).toEqual(first);
    expect(await replayTrace(trace, { setup, receipt: first.receipt })).toEqual(first);
    expect(first.decisions.some(decision => decision.enabled.length > 1)).toBe(true);
  });

  // Full-suite CPU contention reached 5036 ms; 20 s keeps the microtask workload unchanged.
  it("fast-check drives the same queue rather than a second scheduler", async () => {
    await fc.assert(fc.asyncProperty(fc.integer(), async seed => {
      const run = async () => {
        const entropy = new Entropy(seed);
        const scheduler = new Scheduler(entropy);
        const result: number[] = [];
        for (let i = 0; i < 10; i++) scheduler.enqueue(`op-${i}`, () => result.push(i));
        await scheduler.drain();
        return { result, choices: entropy.choices };
      };
      expect(await run()).toEqual(await run());
    }), { seed: 19, numRuns: 20 });
  }, 20000);

  it("rejects a replay when the enabled set changes", () => {
    const entropy = new Entropy(1, [0]);
    entropy.choose("schedule", 1, ["a"]);
    expect(() => new Entropy(1, [], entropy.choices).choose("schedule", 1, ["b"])).toThrow("Replay diverged");
  });

  it("runs timers only as queue operations and carries actor identity across awaits", async () => {
    const world = new SimWorld(4);
    try {
      world.createActor("lead"); world.createActor("w1");
      const observed: Array<[string, number]> = [];
      for (const actor of ["lead", "w1"]) world.enqueue(actor, "start", async () => {
        const pid = hostEnv().process.pid;
        await new Promise<void>(resolve => hostEnv().clock.setTimeout(resolve, 10));
        observed.push([actor, hostEnv().process.pid]);
        expect(hostEnv().process.pid).toBe(pid);
      });
      await world.drain();
      expect(observed).toEqual([]);
      world.scheduler.advance(10);
      await world.drain();
      expect(observed).toHaveLength(2);
      expect(new Set(observed.map(([, pid]) => pid)).size).toBe(2);
    } finally { world.dispose(); }
  });

  it("cancels intervals and queued callbacks on actor death", async () => {
    const world = new SimWorld(4);
    try {
      const env = world.createActor("w1");
      let calls = 0;
      world.enter("w1", () => hostEnv().clock.setInterval(() => { calls++; }, 1));
      world.scheduler.advance(1); await world.drain();
      expect(calls).toBe(1);
      world.killPid(env.process.pid);
      world.scheduler.advance(100); await world.drain();
      expect(calls).toBe(1);
    } finally { world.dispose(); }
  });

  it("retains distinct birth and boot identities across reuse and reboot", () => {
    const table = new ProcessTable();
    const first = table.spawn("w1");
    table.kill(first.pid);
    const next = table.reuse("w1", "other");
    expect(next.pid).toBe(first.pid);
    expect(next.osBirthToken).not.toBe(first.osBirthToken);
    table.reboot();
    const third = table.spawn("w1", { pid: first.pid });
    expect(third.bootId).not.toBe(first.bootId);
    expect(table.generation(first.pid)).toEqual({ kind: "found", generation: { pid: third.pid, bootId: third.bootId, osBirthToken: third.osBirthToken } });
  });

  it("queues watchers after real atomic rename and drops closed notifications", async () => {
    const world = new SimWorld(4);
    try {
      world.createActor("lead");
      const observed: Array<string | null> = [];
      let close!: () => void;
      world.enter("lead", () => {
        const watch = hostEnv().watch.watchDirectory(world.workspace.home, file => observed.push(file));
        close = () => watch.close();
        fs.writeFileSync(path.join(world.workspace.home, "draft"), "one");
        fs.renameSync(path.join(world.workspace.home, "draft"), path.join(world.workspace.home, "published"));
        watch.onError(error => observed.push(String(error)));
      });
      expect(observed).toEqual([]);
      await world.drain();
      expect(observed).toContain("published");
      const count = observed.length;
      world.enter("lead", () => fs.writeFileSync(path.join(world.workspace.home, "closed"), "two"));
      close();
      await world.drain();
      expect(observed).toHaveLength(count);
      expect(fs.readFileSync(path.join(world.workspace.home, "published"), "utf8")).toBe("one");
    } finally { world.dispose(); }
  });

  it("fails on real timers, subprocesses, filesystem escape and symlink escape even if caught", () => {
    const world = new SimWorld(4);
    try {
      world.createActor("lead");
      fs.symlinkSync(path.dirname(world.workspace.root), path.join(world.workspace.home, "escape"));
      world.enter("lead", () => {
        expect(() => setTimeout(() => {}, 1)).toThrow("Real timer");
        expect(() => spawnSync("__ptb_sim_forbidden__", [])).toThrow("Real subprocess");
        expect(() => fs.readFileSync(path.join(world.workspace.root, "..", "outside"))).toThrow("outside world root");
        expect(() => fs.readdirSync(path.join(world.workspace.home, "escape"))).toThrow("symlink escapes");
        expect(() => fs.readSync(0, Buffer.alloc(1), 0, 1, 0)).toThrow("Unowned");
      });
      expect(() => world.guard.assertClean()).toThrow("Host escape");
    } finally { world.dispose(); }
  });

  it("uses real Pi branch semantics with deterministic ids and time", () => {
    const run = () => {
      const world = new SimWorld(6);
      try {
        const session = createSimSession(world.createActor("lead"), world.workspace.home);
        const first = session.appendCustomEntry("one", { value: 1 });
        session.appendCustomEntry("discarded", {});
        session.branch(first);
        session.appendCustomEntry("two", {});
        session.appendCompaction("summary", first, 100);
        return { id: session.getSessionId(), branch: session.getBranch(), entries: session.getEntries() };
      } finally { world.dispose(); }
    };
    const first = run();
    expect(run()).toEqual(first);
    expect(first.branch.some(entry => entry.type === "custom" && entry.customType === "discarded")).toBe(false);
    expect(first.entries.length).toBeGreaterThan(first.branch.length);
    expect(first.branch[0]?.timestamp).toBe("2023-11-14T22:13:20.000Z");
  });

  it("reports wall time per 1000 scheduled operations", async () => {
    const scheduler = new Scheduler(new Entropy(9));
    for (let i = 0; i < 1000; i++) scheduler.enqueue(`benchmark-${i}`, () => {});
    const started = performance.now();
    await scheduler.drain();
    console.info(`sim benchmark: ${(performance.now() - started).toFixed(2)} ms / 1000 runnable operations (single trial)`);
    expect(scheduler.decisions).toHaveLength(1000);
  });
});
