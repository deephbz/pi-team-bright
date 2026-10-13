import { expect, it } from "vitest";
import { WorldReplay, replayTrace } from "./replay";
import { SimWorld } from "./world";
import type { WorldTrace } from "./trace-format";
import { generatedTrace } from "./v31-schedules";
import shutdownResume from "./fixtures/traces/shutdown-resume.json";

const who = { team: "team-1", actor: "lead" };
const start: WorldTrace["steps"][number] = { at: 0, step: { kind: "pi.start", who, session: "session-1", reason: "startup" } };
const trace = (steps: WorldTrace["steps"]): WorldTrace => ({ version: 1, id: "exact-generation-restart", source: "synthetic", assumptions: [], setup: { ptbVersion: "v3.1", teams: [] }, steps });

it("starts a new actor for the same role and reused PID without reviving the old actor", async () => {
  const world = new SimWorld(42);
  try {
    const runner = new WorldReplay(world);
    await runner.run(trace([start]));
    const old = [...runner.actors.values()][0]!;
    const oldProcess = world.processes.actor("team-1/lead")!;
    await runner.run(trace([
      { at: 0, step: { kind: "os.kill", who, signal: "SIGKILL" } },
      { at: 0, step: { kind: "os.pidReuse", dead: who, newcomer: "team-1/lead" } },
      { ...start, step: { ...start.step as Extract<typeof start.step, { kind: "pi.start" }>, session: "session-2" } },
    ]));
    const replacement = world.processes.actor("team-1/lead")!;
    expect(replacement.pid).toBe(oldProcess.pid);
    expect(replacement.bootId).toBe(oldProcess.bootId);
    expect(replacement.osBirthToken).not.toBe(oldProcess.osBirthToken);
    expect(oldProcess.alive).toBe(false);
    expect(replacement.alive).toBe(true);
    expect(runner.actors.size).toBe(2);
    const current = [...runner.actors.values()].at(-1)!;
    expect(current).not.toBe(old);
    expect(current.session.getSessionId()).not.toBe(old.session.getSessionId());
    await expect(old.emit("session_start", { reason: "reload" })).rejects.toThrow("Actor is not live");
    await expect(current.emit("session_start", { reason: "reload" })).resolves.toBeDefined();
  } finally { world.dispose(); }
});

it("keeps stale Worker handles dead after recovery while an outsider holds the old PID", async () => {
  const world = new SimWorld(42);
  try {
    const runner = new WorldReplay(world);
    const full = generatedTrace({ family: 0, seed: 42, gap: 0, repeats: 1 }, "pid-reuse-stale-handle");
    await runner.run({ ...full, steps: full.steps.slice(0, 3) });
    const old = [...runner.actors.values()].find(actor => actor.id === "team-1/w1")!;
    await runner.run({ ...full, steps: full.steps.slice(3) });
    const outsider = world.processes.actor("outsider-1")!;
    expect(outsider.alive).toBe(true);
    await expect(old.emit("session_start", { reason: "reload" })).rejects.toThrow("Actor is not live");
    await expect(old.tool("team_sync", { view: "snapshot" })).rejects.toThrow("Actor is not live");
    await expect(old.settle()).rejects.toThrow("Actor is not live");
  } finally { world.dispose(); }
});

it("replays a lead restart after reboot with a new boot identity", async () => {
  const input = trace([start, { at: 0, step: { kind: "os.reboot" } }, { at: 1, step: { kind: "pi.start", who, session: "session-2", reason: "startup" } }]);
  const result = await replayTrace(input, { seed: 42 });
  const leads = result.processes.filter(process => process.actor === "team-1/lead");
  expect(leads).toHaveLength(2);
  expect(leads[0]!.alive).toBe(false);
  expect(leads[1]!.alive).toBe(true);
  expect(leads[1]!.bootId).not.toBe(leads[0]!.bootId);
  const repeated = await replayTrace(input, { receipt: result.receipt });
  expect(repeated.history).toEqual(result.history);
});

it("resumes the exact Session on a new generation after shutdown and reboot", async () => {
  const result = await replayTrace(shutdownResume as WorldTrace, { seed: 42 });
  const leads = result.actors.filter(actor => actor.id === "team-1/lead");
  expect(leads).toHaveLength(2);
  expect(leads[1]!.sessionId).toBe(leads[0]!.sessionId);
  expect(leads.map(actor => actor.alive)).toEqual([false, true]);
  const sync = result.history.filter(entry => entry.kind === "tool.result").find(entry => entry.name === "team_sync");
  expect(sync!.result.details).toMatchObject({ kind: "snapshot", team: { name: "team-1" } });
});
