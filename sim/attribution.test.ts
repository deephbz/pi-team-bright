import { expect, it } from "vitest";
import { replayTrace } from "./replay";
import type { WorldTrace } from "./trace-format";
import deadPi from "./fixtures/traces/bound-pi-dead.json";
import { generatedTrace } from "./v31-schedules";
import { p5ClosesCited } from "./monitors/safety";

// Full-suite CPU contention reached 3982 ms; 15 s gives the real-actor replay headroom.
it("distinguishes Membership-associated Worker, lead, shell and reused unrelated process", async () => {
  const result = await replayTrace(generatedTrace({ family: 0, seed: 42, gap: 0, repeats: 1 }, "classified-pid-reuse"), { seed: 42 });
  const deaths = result.history.filter(entry => entry.kind === "process.death");
  const workerDeath = deaths.find(entry => entry.process.actorKey === "team-1/w1");
  expect(workerDeath?.process).toMatchObject({ processKind: "worker_pi", membershipId: expect.any(String) });
  const births = result.history.filter(entry => entry.kind === "process.birth");
  expect(births.find(entry => entry.process.actorKey === "team-1/lead")?.process).toMatchObject({ processKind: "lead_pi" });
  expect(births.filter(entry => entry.process.command === "shell").every(entry => entry.process.processKind === "shell")).toBe(true);
  const outsider = births.find(entry => entry.process.actorKey === "outsider-1")!;
  expect(outsider.process).toMatchObject({ processKind: "other", generation: { pid: workerDeath!.process.generation.pid } });
  expect(outsider.process.membershipId).toBeUndefined();
  expect(outsider.process.generation.osBirthToken).not.toBe(workerDeath!.process.generation.osBirthToken);
  const admitted = result.history.filter(entry => entry.kind === "durable.runtime").find(entry => entry.record?.pid === workerDeath!.process.generation.pid && entry.record?.osBirthToken === workerDeath!.process.generation.osBirthToken);
  expect(workerDeath!.process.membershipId).toBe(admitted!.record!.membershipId);
}, 15000);

it("preserves the shell after human Pi quit and attributes the subsequent human close", async () => {
  const trace = structuredClone(deadPi) as WorldTrace;
  trace.steps = [...trace.steps.slice(0, 3),
    { at: 10, step: { kind: "pi.shutdown", who: { team: "team-1", actor: "w1" }, reason: "quit" } },
    { at: 20, step: { kind: "human.closePane", pane: "pane-1" } },
  ];
  const result = await replayTrace(trace, { seed: 42 });
  const quit = result.history.find(e => e.kind === "world.input" && e.step.kind === "pi.shutdown")!;
  const closeInput = result.history.find(e => e.kind === "world.input" && e.step.kind === "human.closePane")!;
  const between = result.history.filter(e => e.sequence > quit.sequence && e.sequence < closeInput.sequence);
  expect(between.filter(e => e.kind === "pane.close")).toHaveLength(0);
  const deaths = between.filter(e => e.kind === "process.death");
  expect(deaths).toHaveLength(1);
  expect(deaths[0]).toMatchObject({ origin: { kind: "human" }, process: { processKind: "worker_pi" } });
  expect(result.history.filter(e => e.kind === "pane.close")).toMatchObject([{ origin: { kind: "human" } }]);
  expect(result.history.filter(e => e.kind === "process.death").at(-1)).toMatchObject({ origin: { kind: "human" }, process: { processKind: "shell" } });
  expect(p5ClosesCited(result.history)).toEqual({ status: "pass" });
});
