import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { SimWorld } from "../world";
import type { HistoryFact, JsonObject } from "../history";
import { p2GoneMatchesWorldTruth, p3LiveIsFresh, p8CoverageLedger, p10JournalMatchesWorldTruth } from "./safety";
import { e1ExitReachesCarrierView, e2EventReachesBranch, e3LaunchCompletesOrReportsUnknown, e4BlockedAttentionOncePerEpoch } from "./liveness";
import { s6SuspectedHumanStopWitness } from "./witnesses";

const generation = { pid: 104, bootId: "boot-1", osBirthToken: "birth-1" };
const processFact = { actorKey: "team-1/w1", command: "pi", generation, processKind: "worker_pi" as const, membershipId: "member-1" };
function journal(carriers: JsonObject[], before: HistoryFact[] = [], after: HistoryFact[] = [], endAt = 100) {
  const world = new SimWorld(42);
  try {
    for (const fact of before) world.record(fact);
    const file = path.join(world.workspace.home, ".pi/teams/team-1/events/team-events.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = carriers.map((carrier, i) => ({ type: "worker", worker: "w1", membershipId: "member-1", phase: "carrier", cursor: String(i + 1), at: new Date(i).toISOString(), carrier: { membership: "member-1", generation, cause: { source: "process_generation", fact: "sampled" }, ...carrier } }));
    for (let i = 0; i < rows.length; i++) {
      world.scheduler.advance(i ? 3001 : 0);
      fs.appendFileSync(file, JSON.stringify(rows[i]) + "\n"); world.observer.sample();
    }
    for (const fact of after) world.record(fact);
    world.scheduler.advance(endAt); world.record({ kind: "test.sample", value: "end" });
    expect(world.history.filter(e => e.kind === "journal.append").map(e => e.event.raw)).toEqual(rows);
    expect(world.history.filter(e => e.kind === "journal.append").map(e => e.event.seq)).toEqual(rows.map((_, i) => i + 1));
    return world.history;
  } finally { world.dispose(); }
}

it("P2 reads a real nested process claim without changing raw bytes", () => {
  const history = journal([{ field: "process", to: "gone" }], [{ kind: "process.birth", process: processFact }]);
  const original = JSON.stringify(history);
  expect(p2GoneMatchesWorldTruth(history).status).toBe("violation");
  expect(JSON.stringify(history)).toBe(original);
});
it("P3 reads the nested live field against world death", () => {
  const idle = Array.from({ length: 4 }, () => ({ field: "activity", to: "idle" }));
  expect(p3LiveIsFresh(journal([...idle, { field: "process", to: "live" }], [{ kind: "process.death", process: processFact }])).status).toBe("violation");
});
it("P8 derives event order from the persisted cursor", () => {
  const stamp = { team: "team-1", epoch: "epoch-1", binding: "binding-1", from: 1, through: 2 };
  expect(p8CoverageLedger(journal([{ field: "process", to: "gone" }], [], [{ kind: "lead.entry", actor: { team: "team-1", actor: "lead" }, sessionId: "s1", entryId: "e1", entry: {}, stamp }])).status).toBe("violation");
});
it("P10 reads a nested pane coordinate", () => {
  expect(p10JournalMatchesWorldTruth(journal([{ field: "terminal", to: "absent", paneId: "missing-pane" }])).status).toBe("violation");
});
it("S6 reads nested suspected-human-stop evidence", () => {
  expect(s6SuspectedHumanStopWitness(journal([{ field: "terminal", to: "absent", suspectedHumanStop: true }])).status).toBe("witnessed");
});
it("E1 reads the nested process transition after world death", () => {
  expect(e1ExitReachesCarrierView(journal([{ field: "process", to: "gone" }], [{ kind: "process.death", process: processFact }]), { deadlineMs: 60000 }).status).toBe("pass");
});
it("E2 covers a persisted cursor event by a branch stamp", () => {
  const stamp = { team: "team-1", epoch: "epoch-1", binding: "binding-1", from: 0, through: 1 };
  expect(e2EventReachesBranch(journal([{ field: "process", to: "gone" }], [], [{ kind: "world.input", input: 0, step: { kind: "agent.settled", who: { team: "team-1", actor: "lead" } } }, { kind: "lead.entry", actor: { team: "team-1", actor: "lead" }, sessionId: "s1", entryId: "e1", entry: {}, stamp }]), { latencyMs: 60000 }).status).toBe("pass");
});
it("E3 reads a nested launch result", () => {
  expect(e3LaunchCompletesOrReportsUnknown(journal([{ field: "launch", to: "started", launchId: "launch-1" }], [{ kind: "durable.launch", team: "team-1", path: "launch", source: "member", record: { raw: {}, membershipId: "member-1", pendingLaunchId: "launch-1" } }]), { boundMs: 60000 }).status).toBe("pass");
});
it("E4 reads the production blocked attention field", () => {
  expect(e4BlockedAttentionOncePerEpoch(journal([{ field: "activity", to: "blocked" }, { field: "blocked", to: "blocked", nextActionHint: "ask_human" }]), { thresholdMs: 3000 }).status).toBe("pass");
});
