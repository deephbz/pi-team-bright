import { describe, expect, it } from "vitest";
import { SimActor } from "./actor";
import { SimWorld } from "./world";
import { loadActorExtension } from "./actor-loader";
import { ReplayBoundExceededError, replayTrace, WorldReplay } from "./replay";
import type { WorldTrace } from "./trace-format";
import deadPi from "./fixtures/traces/bound-pi-dead.json";

/** Real extension factories use actor-scoped capabilities, including during module configuration. */
describe("real extension actor harness", () => {
  it.each([
    { maxSteps: 0, maxVirtualMs: 100 },
    { maxSteps: 100, maxVirtualMs: 0 },
  ])("classifies replay bounds without matching diagnostics: %j", async bounds => {
    const world = new SimWorld(1);
    try {
      const trace: WorldTrace = { version: 1, id: "bounded", source: "synthetic", assumptions: [],
        setup: { ptbVersion: "v3.1", teams: [] },
        steps: [{ at: 1, step: { kind: "fault.clear", source: "herdr" } }],
      };
      const error = await new WorldReplay(world).run(trace, bounds).catch(error => error);
      expect(error).toBeInstanceOf(ReplayBoundExceededError);
      expect(error).toMatchObject({ kind: "replay_bound_exceeded", bounds, observed: {
        steps: 1, virtualMs: 1, lastOperation: "1:input:0:fault.clear",
      } });
      expect(error.message).toContain("1/");
    } finally { world.dispose(); }
  });

  it("drops a killed Worker's pending startup input while the lead continues", async () => {
    const trace = structuredClone(deadPi) as WorldTrace;
    trace.id = "startup-input-owner";
    for (const input of trace.steps) if (input.at >= 2) input.at = input.step.kind === "os.kill" ? 7 : 20;
    const result = await replayTrace(trace, { seed: 2 });
    expect((await replayTrace(trace, { receipt: result.receipt })).history).toEqual(result.history);
    const death = result.history.find(e => e.kind === "process.death" && e.process.actorKey === "team-1/w1");
    expect(death).toBeDefined();
    const recovery = result.history.find(e => e.kind === "tool.result" && e.name === "ensure_worker" && e.sequence > death!.sequence);
    expect(recovery?.kind === "tool.result" && recovery.result.details).toMatchObject({ kind: "attention", reason: "launch_pending" });
    expect(result.history.some(e => e.kind === "durable.runtime" && e.record?.agentName === "w1")).toBe(false);
  }, 15000);

  it("loads independent lead and Worker tool projections", async () => {
    const world = new SimWorld(1);
    try {
      const lead = new SimActor(world, "lead");
      lead.initialize(await loadActorExtension(world.envs.get("lead")!.process.env));
      const worker = new SimActor(world, "w1", { PI_TEAM_NAME: "synthetic-team" });
      worker.initialize(await loadActorExtension(world.envs.get("w1")!.process.env));
      expect([...lead.tools.keys()]).toContain("ensure_worker");
      expect([...worker.tools.keys()].sort()).toEqual(["alert_send", "task_read", "task_update"]);
      expect(lead.handlers.get("session_start")?.length).toBeGreaterThan(0);
      expect(worker.session.getSessionId()).not.toEqual(lead.session.getSessionId());
    } finally { world.dispose(); }
  });

  it("replays real lead startup, settled hooks, and shutdown identically", async () => {
    const who = { team: "team-1", actor: "lead" };
    const trace: WorldTrace = { version: 1, id: "real-lead-hooks", source: "synthetic", assumptions: ["A3", "A5"], setup: { ptbVersion: "baseline", teams: [] }, steps: [
      { at: 0, step: { kind: "pi.start", who, session: "s1", reason: "startup" } },
      { at: 1, step: { kind: "agent.settled", who } },
      { at: 2, step: { kind: "pi.shutdown", who, reason: "quit" } },
    ] };
    const first = await replayTrace(trace, { seed: 8 });
    expect(await replayTrace(trace, { receipt: first.receipt })).toEqual(first);
    expect(first.assumptions.find(item => item.assumption === "A3")?.status).toBe("probe-backed");
  });

  it("persists branch entries and queues streaming follow-ups in virtual time", async () => {
    const world = new SimWorld(2);
    try {
      const actor = new SimActor(world, "lead");
      actor.idle = false;
      actor.api.sendMessage({ customType: "synthetic", content: "queued", display: false }, { deliverAs: "followUp" });
      expect(actor.session.getBranch()).toHaveLength(0);
      await actor.settle();
      expect(actor.session.getBranch()).toHaveLength(0);
      await world.drain();
      expect(actor.session.getBranch()).toHaveLength(1);
      expect(actor.session.getBranch()[0]?.type).toBe("custom_message");
    } finally { world.dispose(); }
  });
});
