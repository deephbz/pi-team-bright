import { describe, expect, it } from "vitest";
import { SimActor } from "./actor";
import { SimWorld } from "./world";
import { loadActorExtension } from "./actor-loader";
import { replayTrace } from "./replay";
import type { WorldTrace } from "./trace-format";

/** Real extension factories use actor-scoped capabilities, including during module configuration. */
describe("real extension actor harness", () => {
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
