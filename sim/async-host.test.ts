import { describe, expect, it } from "vitest";
import { hostEnv, type ExecOutcome } from "../src/env/host-env";
import { SimWorld } from "./world";
import { resolveResultRefs } from "./replay";

describe("bounded host operations", () => {
  it("separates command arrival, effect, and completion and keeps timeout effects unknown", async () => {
    const world = new SimWorld(91);
    try {
      world.createActor("lead");
      let effects = 0;
      let outcome: ExecOutcome | undefined;
      world.exec.register("herdr", () => { effects++; return { stdout: "done", stderr: "", status: 0 }; });
      world.faults.set("herdr", { source: "herdr", mode: "slow" });
      world.enqueue("lead", "call", async () => {
        outcome = await hostEnv().exec.run("herdr", [], { timeoutMs: 10 });
        expect(hostEnv().process.env.PI_AGENT_NAME).toBe("team-lead");
      });
      await world.drain();
      expect(effects).toBe(1);
      expect(outcome).toBeUndefined();
      world.scheduler.advance(10); await world.drain();
      expect(outcome).toEqual({ kind: "timeout", afterMs: 10 });
      world.scheduler.advance(100); await world.drain();
      expect(outcome).toEqual({ kind: "timeout", afterMs: 10 });
      const labels = world.scheduler.decisions.map(d => d.selected);
      expect(labels.some(label => label.endsWith("exec.arrival"))).toBe(true);
      expect(labels.some(label => label.endsWith("exec.effect"))).toBe(true);
      expect(labels.some(label => label.endsWith("exec.completion"))).toBe(true);
    } finally { world.dispose(); }
  });

  it("rejects sleeps on queued abort and drops a dead generation's completion", async () => {
    const world = new SimWorld(18);
    try {
      const env = world.createActor("w1");
      let aborted = false;
      const abort = new AbortController();
      world.enqueue("w1", "sleep", async () => {
        try { await hostEnv().clock.sleep(100, abort.signal); }
        catch (error) { aborted = (error as Error).name === "AbortError"; }
      });
      await world.drain();
      abort.abort();
      expect(aborted).toBe(false);
      await world.drain();
      expect(aborted).toBe(true);
      let resurrected = false;
      world.enqueue("w1", "sleep-until-crash", async () => { await hostEnv().clock.sleep(10); resurrected = true; });
      await world.drain();
      world.killPid(env.process.pid);
      world.processes.reuse("w1", "unrelated");
      world.scheduler.advance(100); await world.drain();
      expect(resurrected).toBe(false);
    } finally { world.dispose(); }
  });

  it("models synchronous blocking without running another actor", async () => {
    const world = new SimWorld(4);
    try {
      world.createActor("lead"); world.createActor("w1");
      const seen: string[] = [];
      world.enter("w1", () => hostEnv().clock.setTimeout(() => { seen.push("worker"); }, 5));
      world.enter("lead", () => { hostEnv().clock.sleepSync(10); seen.push("lead"); });
      expect(seen).toEqual(["lead"]);
      await world.drain();
      expect(seen).toEqual(["lead", "worker"]);
      expect(() => hostEnv()).toThrow("outside a simulated actor");
    } finally { world.dispose(); }
  });

  it("resolves result references but never refreshes a literal version", () => {
    const results = new Map<number, unknown>([[1, { details: { version: "v_current" } }]]);
    expect(resolveResultRefs({ current: { $fromStep: 1, path: "details.version" }, stale: "v_stale" }, results)).toEqual({ current: "v_current", stale: "v_stale" });
    expect(() => resolveResultRefs({ $fromStep: 2, path: "details.version" }, results)).toThrow("unavailable");
  });
});
