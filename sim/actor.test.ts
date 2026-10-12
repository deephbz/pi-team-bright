import { describe, expect, it, vi } from "vitest";
import { SimActor } from "./actor";
import { SimWorld } from "./world";

/** These bootstrap env stubs characterize the pre-C0 factory. C0 removes that need. */
describe("real extension actor harness", () => {
  it.skip("loads independent lead and Worker tool projections (blocked on C0 HOME path integration)", () => {
    const world = new SimWorld(1);
    try {
      vi.stubEnv("PI_AGENT_NAME", "team-lead");
      const lead = new SimActor(world, "lead");
      lead.initialize();
      vi.stubEnv("PI_AGENT_NAME", "w1");
      const worker = new SimActor(world, "w1", { PI_TEAM_NAME: "synthetic-team" });
      worker.initialize();
      expect([...lead.tools.keys()]).toContain("ensure_worker");
      expect([...worker.tools.keys()].sort()).toEqual(["alert_send", "task_read", "task_update"]);
      expect(lead.handlers.get("session_start")?.length).toBeGreaterThan(0);
      expect(worker.session.getSessionId()).not.toEqual(lead.session.getSessionId());
    } finally { vi.unstubAllEnvs(); world.dispose(); }
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
