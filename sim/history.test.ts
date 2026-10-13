import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import neverStarts from "./fixtures/traces/never-starts.json";
import deadPi from "./fixtures/traces/bound-pi-dead.json";
import { replayTrace } from "./replay";
import type { WorldTrace } from "./trace-format";
import { SimWorld } from "./world";
import { HISTORY_VERSION } from "./history";

// Full-suite CPU contention reached 2657 ms; retain 30 s for both real-actor fixtures.
it.each([neverStarts, deadPi])("records observable oracle inputs for $id", async fixture => {
  const result = await replayTrace(fixture as WorldTrace, { seed: 42 });
  const history = result.history;
  expect(history.every((event, index) => event.version === HISTORY_VERSION && event.sequence === index + 1)).toBe(true);
  expect(history.every((event, index) => !index || event.at >= history[index - 1]!.at)).toBe(true);
  expect(history.filter(event => event.kind === "disk.invalid")).toEqual([]);
  const calls = history.filter(event => event.kind === "tool.call");
  const results = history.filter(event => event.kind === "tool.result");
  for (const call of calls) {
    const receipt = results.find(event => event.callId === call.callId)!;
    expect(receipt).toBeDefined();
    expect(receipt.actor).toEqual(call.actor);
    expect(receipt.at).toBeGreaterThanOrEqual(call.at);
  }
  const execs = history.filter(event => event.kind === "exec.call");
  expect(execs.some(event => event.command === "bd")).toBe(true);
  expect(execs.some(event => event.command === "herdr")).toBe(true);
  for (const call of execs) expect(history.some(event => event.kind === "exec.result" && event.callId === call.callId)).toBe(true);
  const bound = history.find(event => event.kind === "journal.append" && event.event.type === "worker" && event.event.raw.phase === "session_bound");
  if (fixture.id === neverStarts.id) expect(bound).toBeUndefined();
  else expect(bound).toBeDefined();
  expect(history.some(event => event.kind === "durable.runtime" && event.record?.membershipId && event.record.pid)).toBe(true);
  expect(history.some(event => event.kind === "durable.team" && event.record)).toBe(true);
  expect(history.some(event => event.kind === "durable.launch" && event.record)).toBe(true);
  expect(history.some(event => event.kind === "lead.entry" && event.toolCallId === results[0]!.callId)).toBe(true);
  expect(history.flatMap(event => event.kind === "step.begin" ? [event.operationId] : []))
    .toEqual(history.flatMap(event => event.kind === "step.end" ? [event.operationId] : []));
  if (fixture.id === neverStarts.id) {
    expect(history.some(event => event.kind === "pane.close" && event.pane.paneId === "pane-1")).toBe(false);
    expect(results.filter(event => event.name === "ensure_worker").at(-1)?.result.details).toMatchObject({ kind: "attention" });
    expect(history.some(event => event.kind === "fault.set" && event.fault.source === "pi.start")).toBe(true);
    expect(history.some(event => event.kind === "fault.clear" && event.source === "pi.start")).toBe(true);
    expect(history.some(event => event.kind === "lead.entry" && event.stamp)).toBe(true);
  } else {
    const death = history.find(event => event.kind === "process.death" && event.process.actorKey === "team-1/w1")!;
    const birth = history.find(event => event.kind === "process.birth" && event.process.actorKey === "team-1/w1")!;
    expect(death.kind === "process.death" && birth.kind === "process.birth" && death.process.generation).toEqual(birth.kind === "process.birth" && birth.process.generation);
    expect(death.origin).toMatchObject({ kind: "os" });
    expect(results.some(event => event.name === "ensure_worker" && event.at >= death.at)).toBe(true);
  }
}, 30000);

// Full-suite CPU contention reached 8105 ms; retain 30 s for the long virtual-time replay.
it("observes automatic team-update branch stamps through the real Pi boundary", async () => {
  // This trace has unread recovery events. neverStarts consumed its events through team_sync.
  const trace = structuredClone(deadPi) as WorldTrace;
  trace.id = "owner-scenario-with-idle-update";
  trace.steps.push({ at: 300500, step: { kind: "agent.settled", who: { team: "team-1", actor: "lead" } } });
  trace.steps.push({ at: 350000, step: { kind: "agent.settled", who: { team: "team-1", actor: "lead" } } });
  const result = await replayTrace(trace);
  const update = result.history.find(event => event.kind === "lead.entry" && event.entry.customType === "ptb.team-update");
  expect(update).toBeDefined();
  expect(update?.kind === "lead.entry" && update.stamp).toMatchObject({ team: "team-1" });
  expect(result.history.some(event => event.kind === "lead.branch" && event.entryIds.includes(update!.kind === "lead.entry" ? update!.entryId : ""))).toBe(true);
}, 30000);

it("keeps human pane closure distinct from PTB closure and preserves immutable birth evidence", async () => {
  const world = new SimWorld(4);
  try {
    const pane = world.withOrigin({ kind: "human", input: 0 }, () => world.herdr.spawn("human-pane"));
    world.withOrigin({ kind: "human", input: 1 }, () => world.herdr.close(pane.id));
    const birth = world.history.find(event => event.kind === "process.birth")!;
    expect(birth.kind === "process.birth" && birth.process.generation.pid).toBe(pane.shellPid);
    expect(world.history.find(event => event.kind === "pane.close")?.origin).toEqual({ kind: "human", input: 1 });
    expect(world.history.filter(event => event.kind === "process.death")).toHaveLength(1);
  } finally { world.dispose(); }
});

it("preserves journal line coordinates and exposes replacement without duplicating unchanged rows", () => {
  const world = new SimWorld(6);
  try {
    const journal = path.join(world.workspace.home, ".pi/teams/team-1/events/team-events.jsonl");
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    const first = JSON.stringify({ type: "worker", cursor: "1", worker: "w1", phase: "prepared" });
    const second = JSON.stringify({ type: "worker", cursor: "2", worker: "w1", phase: "session_bound" });
    fs.writeFileSync(journal, `\n${first}\n`);
    world.observer.sample();
    world.observer.sample();
    expect(world.history.filter(event => event.kind === "journal.append")).toHaveLength(1);
    expect(world.history.at(-1)).toMatchObject({ kind: "journal.append", line: 2, event: { cursor: "1" } });
    fs.appendFileSync(journal, `${second}\n`);
    world.observer.sample();
    expect(world.history.at(-1)).toMatchObject({ kind: "journal.append", line: 3, event: { cursor: "2" } });
    fs.writeFileSync(journal, `${second}\n`);
    world.observer.sample();
    expect(world.history.at(-2)?.kind).toBe("journal.reset");
    expect(world.history.at(-1)).toMatchObject({ kind: "journal.append", line: 1 });
  } finally { world.dispose(); }
});

it("samples persisted records without consulting PTB state and records deletion and corrupt bytes", () => {
  const world = new SimWorld(5);
  try {
    const runtime = path.join(world.workspace.home, ".pi/teams/team-1/runtime/w1.json");
    fs.mkdirSync(path.dirname(runtime), { recursive: true });
    fs.writeFileSync(runtime, JSON.stringify({ membershipId: "member-1", pid: 444, startedAt: 123, bootId: "claimed-boot", osBirthToken: "claimed-birth" }));
    world.observer.sample();
    const observed = world.history.find(event => event.kind === "durable.runtime")!;
    expect(observed.kind === "durable.runtime" && observed.record).toMatchObject({ pid: 444, bootId: "claimed-boot", osBirthToken: "claimed-birth" });
    expect(world.processes.exists(444)).toBe(false);
    fs.writeFileSync(runtime, "{torn");
    world.observer.sample();
    expect(world.history.at(-1)?.kind).toBe("disk.invalid");
    fs.rmSync(runtime);
    world.observer.sample();
    expect(world.history.at(-1)).toMatchObject({ kind: "durable.runtime", record: null });
  } finally { world.dispose(); }
});
