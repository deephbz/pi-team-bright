import { describe, expect, it } from "vitest";
import { HISTORY_VERSION, type HistoryEntry, type HistoryFact, type HistoryOrigin, type JournalFact, type JsonObject } from "../history";
import { e1ExitReachesCarrierView, e2EventReachesBranch, e3LaunchCompletesOrReportsUnknown, e4BlockedAttentionOncePerEpoch, e5ReceiptWithinBound } from "./liveness";
import { p10JournalMatchesWorldTruth, p1SingleAdmittedGeneration, p2GoneMatchesWorldTruth, p3LiveIsFresh, p4ActMatchesWorldTruth, p5ClosesCited, p6OneOutstandingReservation, p7PublicationNeverWritesTasks, p8CoverageLedger, p9NoDuplicatePage } from "./safety";
import { s1PidReuseWitness, s2OverlappingEnsureWitness, s3CrashBeforeRecordWitness, s4HerdrLossInLaunchWitness, s5CompactionAfterUpdateWitness, s6SuspectedHumanStopWitness } from "./witnesses";

// Each monitor has one history that passes and one that violates or witnesses.
// Histories are built from typed facts in sim/history.ts with contiguous sequences.

type Step = [number, HistoryFact, HistoryOrigin?];

const team = "team-1";
const lead = { team, actor: "lead" };
const setup: HistoryOrigin = { kind: "setup" };
const ptb = (toolCallId?: string): HistoryOrigin => ({ kind: "ptb", actor: lead, toolCallId });
const journalPath = "events/team-events.jsonl";
const gen = (pid: number, token = "tok-a", bootId = "boot-1") => ({ pid, bootId, osBirthToken: token });

const h = (...steps: Step[]): HistoryEntry[] =>
  steps.map(([at, fact, origin], index) => ({ ...fact, version: HISTORY_VERSION, sequence: index + 1, at, origin: origin ?? setup }) as HistoryEntry);

const birth = (at: number, actor: string, pid: number, token = "tok-a", bootId = "boot-1"): Step => [
  at,
  { kind: "process.birth", process: { actorKey: `${team}/${actor}`, generation: gen(pid, token, bootId), command: "pi" } },
];
const death = (at: number, actor: string, pid: number, token = "tok-a"): Step => [
  at,
  { kind: "process.death", process: { actorKey: `${team}/${actor}`, generation: gen(pid, token), command: "pi", processKind: "worker_pi", membershipId: "m1" } },
];
const row = (at: number, extra: JsonObject, origin?: HistoryOrigin, worker = "w1"): Step => [
  at,
  { kind: "journal.append", team, path: journalPath, line: 1, event: { type: "worker", worker, raw: extra, ...extra } as JournalFact },
  origin,
];
const filler = (at: number): Step => [at, { kind: "test.sample", value: 0 }];
const ensureCall = (at: number, callId: string): Step => [at, { kind: "tool.call", actor: lead, callId, name: "ensure_worker", args: { name: "w1" } }];
const ensureResult = (at: number, callId: string, effect: string): Step => [
  at,
  { kind: "tool.result", actor: lead, callId, name: "ensure_worker", result: { details: { effect } } },
];
const stamp = (at: number, from: number, through: number, entryId = `e-${from}-${through}`, workers: string[] = ["w1"]): Step => [
  at,
  {
    kind: "lead.entry", actor: lead, sessionId: "s1", entryId, entry: { customType: "ptb.team-update", content: `ptb.team-update: team_sync snapshot.\n${JSON.stringify({ kind: "snapshot", workers: workers.map(name => ({ name })) })}` },
    stamp: { team, epoch: "ep", binding: "b", from, through },
  },
];

describe("P1 single admitted generation per membership", () => {
  const runtime = (at: number, membershipId: string, pid: number, token: string): Step => [
    at,
    { kind: "durable.runtime", team, path: "runtime/w1.json", record: { raw: {}, membershipId, pid, bootId: "boot-1", osBirthToken: token } },
  ];
  it("passes when one generation is live per membership", () => {
    expect(p1SingleAdmittedGeneration(h(birth(0, "w1", 10, "a"), runtime(1, "m1", 10, "a")))).toEqual({ status: "pass" });
  });
  it("violates when two live generations are admitted for one membership", () => {
    const verdict = p1SingleAdmittedGeneration(h(birth(0, "w1", 10, "a"), birth(1, "w1", 11, "b"), runtime(2, "m1", 10, "a"), runtime(3, "m1", 11, "b")));
    expect(verdict).toMatchObject({ status: "violation" });
  });
});

describe("P2 gone claims match world truth", () => {
  it("passes when the claimed generation was dead", () => {
    expect(p2GoneMatchesWorldTruth(h(birth(0, "w1", 10), death(1, "w1", 10), row(2, { field: "process", to: "gone", generation: gen(10) })))).toEqual({ status: "pass" });
  });
  it("violates when the claimed generation was still alive", () => {
    expect(p2GoneMatchesWorldTruth(h(birth(0, "w1", 10), row(1, { field: "process", to: "gone", generation: gen(10) })))).toMatchObject({ status: "violation" });
  });
});

describe("P3 served live claims never name a generation dead over 10 s", () => {
  const live = (at: number) => row(at, { field: "process", to: "live", generation: gen(10) });
  it("passes when the claimed generation died within the 10 s grace", () => {
    expect(p3LiveIsFresh(h(death(0, "w1", 10), live(5000)))).toEqual({ status: "pass" });
  });
  it("violates when the claimed generation has been dead for more than 10 s", () => {
    expect(p3LiveIsFresh(h(death(0, "w1", 10), live(11000)))).toMatchObject({ status: "violation" });
  });
});

describe("P4 reuse and spawn acts match world truth", () => {
  it("passes when a reuse has a live world process", () => {
    expect(p4ActMatchesWorldTruth(h(birth(0, "w1", 10), ensureCall(10, "c1"), ensureResult(20, "c1", "reused")))).toEqual({ status: "pass" });
  });
  it("violates when a reuse has no live world process", () => {
    expect(p4ActMatchesWorldTruth(h(ensureCall(0, "c1"), ensureResult(10, "c1", "reused")))).toMatchObject({ status: "violation" });
  });
});

describe("P5 pane closes are cited", () => {
  const close: Step = [10, { kind: "pane.close", pane: { paneId: "p1", shellPid: 10 } }, ptb("x")];
  it("passes when PTB closes after a stop request", () => {
    const stop: Step = [0, { kind: "tool.call", actor: lead, callId: "s1", name: "worker_stop", args: { worker: "w1" } }, ptb("s1")];
    expect(p5ClosesCited(h(row(0, { paneId: "p1" }, undefined, "w1"), stop, close))).toEqual({ status: "pass" });
  });
  it("violates when a stop of A authorizes closing B's pane (probe unrelatedStop)", () => {
    const stop: Step = [0, { kind: "tool.call", actor: lead, callId: "s1", name: "worker_stop", args: { worker: "w2" } }, ptb("s1")];
    expect(p5ClosesCited(h(row(0, { paneId: "p1" }, undefined, "w1"), stop, close))).toMatchObject({ status: "violation" });
  });
  it("passes when a team stop authorizes the close", () => {
    const stop: Step = [0, { kind: "tool.call", actor: lead, callId: "s1", name: "team_shutdown", args: {} }, ptb("s1")];
    expect(p5ClosesCited(h(row(0, { paneId: "p1" }, undefined, "w1"), stop, close))).toEqual({ status: "pass" });
  });
  it("violates when PTB closes with no stop request", () => {
    expect(p5ClosesCited(h(close))).toMatchObject({ status: "violation" });
  });
  it("does not judge an OS-origin close, which is not a PTB act", () => {
    const osClose: Step = [10, { kind: "pane.close", pane: { paneId: "p1", shellPid: 10 } }, { kind: "os", input: 0 }];
    expect(p5ClosesCited(h(osClose))).toEqual({ status: "pass" });
  });
});

describe("P6 one outstanding reservation per membership", () => {
  const launch = (at: number, path: string, pendingLaunchId: string): Step => [
    at,
    { kind: "durable.launch", team, path, source: "file", record: { raw: {}, membershipId: "m1", pendingLaunchId } },
  ];
  it("passes with one outstanding reservation", () => {
    expect(p6OneOutstandingReservation(h(launch(0, "p1", "L1")))).toEqual({ status: "pass" });
  });
  it("violates with two outstanding reservations on different paths", () => {
    expect(p6OneOutstandingReservation(h(launch(0, "p1", "L1"), launch(1, "p2", "L2")))).toMatchObject({ status: "violation" });
  });
});

describe("P7 publication never writes Task authority", () => {
  const exec = (at: number, args: string[], origin: HistoryOrigin): Step => [
    at,
    { kind: "exec.call", actor: lead, callId: `x${at}`, mode: "sync", command: "bd", args },
    origin,
  ];
  it("passes when the publication operation only reads Tasks", () => {
    expect(p7PublicationNeverWritesTasks(h(row(0, { field: "process", to: "live" }, ptb("t1")), exec(1, ["show", "x"], ptb("t2"))))).toEqual({ status: "pass" });
  });
  it("violates when the publication operation also updates a Task", () => {
    expect(p7PublicationNeverWritesTasks(h(row(0, { field: "process", to: "live" }, ptb("t1")), exec(1, ["update", "x"], ptb("t1"))))).toMatchObject({ status: "violation" });
  });
});

describe("P8 coverage ledger", () => {
  it("passes when the event is inside the stamp's own page", () => {
    expect(p8CoverageLedger(h(row(0, { seq: 1 }), stamp(10, 0, 1)))).toEqual({ status: "pass" });
  });
  it("violates when an event below the page start is never represented", () => {
    expect(p8CoverageLedger(h(row(0, { seq: 1 }), stamp(10, 1, 2)))).toMatchObject({ status: "violation" });
  });
  it("violates when a page through its stamp omits a journaled event (M6)", () => {
    expect(p8CoverageLedger(h(row(0, { seq: 1 }), row(1, { seq: 2 }, undefined, "w2"), stamp(10, 0, 2)))).toMatchObject({ status: "violation" });
  });
  const taskEvent = (at: number, taskId: string): Step => [at, { kind: "journal.append", team, path: journalPath, line: 1, event: { type: "task", seq: 1, raw: { type: "task", ref: { taskId } } } as JournalFact }];
  const taskUpdate = (at: number, taskIds: string[]): Step => [at, {
    kind: "lead.entry", actor: lead, sessionId: "s1", entryId: `u${at}`,
    entry: { customType: "ptb.team-update", content: `ptb.team-update: team_sync updates.\n${JSON.stringify({ kind: "updates", workerChanges: [], taskChanges: taskIds.map(taskId => ({ taskId })) })}` },
    stamp: { team, epoch: "ep", binding: "b", from: 0, through: 1 },
  }];
  it("violates when a page omits a Task event (probe omittedTask)", () => {
    expect(p8CoverageLedger(h(taskEvent(0, "task-a"), taskUpdate(10, [])))).toMatchObject({ status: "violation" });
  });
  it("passes when the page names the Task event", () => {
    expect(p8CoverageLedger(h(taskEvent(0, "task-a"), taskUpdate(10, ["task-a"])))).toEqual({ status: "pass" });
  });
  it("passes the M4 control: snapshot through 0, then the Worker creation update through 2", () => {
    const control = h(row(0, { seq: 1 }, undefined, "w-race"), row(1, { seq: 2 }, undefined, "w-race"), stamp(10, 0, 0, "snapshot", []), stamp(20, 0, 2, "update", ["w-race"]));
    expect(p8CoverageLedger(control)).toEqual({ status: "pass" });
  });
  it("violates the M4 scratch: a snapshot stamped through 2 without the Worker creation changes", () => {
    const mutant = h(row(0, { seq: 1 }, undefined, "w-race"), row(1, { seq: 2 }, undefined, "w-race"), stamp(10, 0, 2, "snapshot", []));
    expect(p8CoverageLedger(mutant)).toMatchObject({ status: "violation" });
  });
});

describe("P9 no duplicate page", () => {
  it("passes with adjacent pages", () => {
    expect(p9NoDuplicatePage(h(stamp(0, 0, 2), stamp(10, 2, 4)))).toEqual({ status: "pass" });
  });
  it("violates with overlapping pages", () => {
    expect(p9NoDuplicatePage(h(stamp(0, 0, 2), stamp(10, 1, 3)))).toMatchObject({ status: "violation" });
  });
});

describe("P10 journal matches world truth", () => {
  const pane: Step = [0, { kind: "pane.create", pane: { paneId: "p9", shellPid: 10 } }];
  it("passes when the journal pane exists in the world", () => {
    expect(p10JournalMatchesWorldTruth(h(pane, row(10, { paneId: "p9" })))).toEqual({ status: "pass" });
  });
  it("violates when the journal names a pane the world never created", () => {
    expect(p10JournalMatchesWorldTruth(h(row(0, { paneId: "p9" })))).toMatchObject({ status: "violation" });
  });
});

describe("E1 bound Worker exits are named ended", () => {
  const options = { deadlineMs: 1000 };
  const gone = (at: number) => row(at, { field: "process", to: "gone", generation: gen(10) });
  it("passes when a journal event names the exited generation inside the deadline", () => {
    expect(e1ExitReachesCarrierView(h(death(0, "w1", 10), gone(100)), options)).toEqual({ status: "pass" });
  });
  it("violates when no event names the exit and the deadline passes", () => {
    expect(e1ExitReachesCarrierView(h(death(0, "w1", 10), filler(5000)), options)).toMatchObject({ status: "violation" });
  });
  it("is N/A under assumption when a fault covers the window", () => {
    const fault: Step = [0, { kind: "fault.set", fault: { source: "herdr", mode: "unavailable" } }];
    expect(e1ExitReachesCarrierView(h(death(0, "w1", 10), fault, filler(5000)), options)).toMatchObject({ status: "not_applicable" });
  });
});

describe("E2 events reach the branch after lead idle", () => {
  const options = { latencyMs: 1000 };
  const idle = (at: number): Step => [at, { kind: "world.input", input: 0, step: { kind: "agent.settled", who: lead } }];
  it("passes when a stamp covers the event inside the latency bound of lead idle", () => {
    expect(e2EventReachesBranch(h(row(0, { seq: 1 }), idle(0), stamp(500, 0, 1)), options)).toEqual({ status: "pass" });
  });
  it("violates when no stamp covers the event after lead idle", () => {
    expect(e2EventReachesBranch(h(row(0, { seq: 1 }), idle(0), filler(5000)), options)).toMatchObject({ status: "violation" });
  });
  it("is N/A when the lead never becomes idle in the window", () => {
    expect(e2EventReachesBranch(h(row(0, { seq: 1 }), filler(5000)), options)).toMatchObject({ status: "not_applicable" });
  });
  it("violates when an append arrives while the lead is already idle (probe alreadyIdle)", () => {
    expect(e2EventReachesBranch(h(idle(0), row(1000, { seq: 1 }), filler(5000)), options)).toMatchObject({ status: "violation" });
  });
  it("passes when the already-idle append reaches the branch inside the bound", () => {
    expect(e2EventReachesBranch(h(idle(0), row(1000, { seq: 1 }), stamp(1500, 0, 1)), options)).toEqual({ status: "pass" });
  });
});

describe("E3 launches complete or report unknown", () => {
  const launch = (at: number, record: JsonObject & { pendingLaunchId?: string; launchConsumedAt?: string }): Step => [
    at,
    { kind: "durable.launch", team, path: "launch/w1.json", source: "file", record: { raw: record, membershipId: "m1", pendingLaunchId: record.pendingLaunchId, launchConsumedAt: record.launchConsumedAt } },
  ];
  const options = { boundMs: 1000 };
  it("passes when the reservation is consumed inside the bound", () => {
    expect(e3LaunchCompletesOrReportsUnknown(h(launch(0, { pendingLaunchId: "L1" }), launch(500, { pendingLaunchId: "L1", launchConsumedAt: "t" })), options)).toEqual({ status: "pass" });
  });
  it("violates when the reservation neither completes nor reports unknown", () => {
    expect(e3LaunchCompletesOrReportsUnknown(h(launch(0, { pendingLaunchId: "L1" }), filler(5000)), options)).toMatchObject({ status: "violation" });
  });
  it("violates when a launch row only states requested past the bound (probe requestedOnly)", () => {
    expect(e3LaunchCompletesOrReportsUnknown(h(launch(0, { pendingLaunchId: "L1" }), row(500, { field: "launch", to: "requested", membershipId: "m1" }), filler(5000)), options)).toMatchObject({ status: "violation" });
  });
  it("passes when the launch row reports a start inside the bound", () => {
    expect(e3LaunchCompletesOrReportsUnknown(h(launch(0, { pendingLaunchId: "L1" }), row(500, { field: "launch", to: "started", membershipId: "m1" }), filler(5000)), options)).toEqual({ status: "pass" });
  });
});

describe("E4 blocked Workers get one attention per epoch", () => {
  const options = { thresholdMs: 1000 };
  it("passes when a blocked Worker gets its attention", () => {
    expect(e4BlockedAttentionOncePerEpoch(h(row(0, { field: "activity", to: "blocked" }), row(100, { field: "attention", to: "blocked" }), filler(5000)), options)).toEqual({ status: "pass" });
  });
  it("violates when a blocked Worker stays blocked with no attention", () => {
    expect(e4BlockedAttentionOncePerEpoch(h(row(0, { field: "activity", to: "blocked" }), filler(5000)), options)).toMatchObject({ status: "violation" });
  });
});

describe("E5 ensure_worker receipts within the bound", () => {
  it("passes when the receipt returns within 10 s", () => {
    expect(e5ReceiptWithinBound(h(ensureCall(0, "c1"), ensureResult(5000, "c1", "created")))).toEqual({ status: "pass" });
  });
  it("violates when the receipt takes longer than 10 s", () => {
    expect(e5ReceiptWithinBound(h(ensureCall(0, "c1"), ensureResult(20000, "c1", "created")))).toMatchObject({ status: "violation" });
  });
});

describe("S1 PID reuse witness", () => {
  it("is witnessed when a dead pid returns with a new birth token in the same boot", () => {
    expect(s1PidReuseWitness(h(birth(0, "w1", 10, "a"), death(10, "w1", 10, "a"), birth(20, "w2", 10, "b")))).toMatchObject({ status: "witnessed" });
  });
  it("is absent when no pid is reused", () => {
    expect(s1PidReuseWitness(h(birth(0, "w1", 10, "a"), death(10, "w1", 10, "a"), birth(20, "w2", 11, "b")))).toEqual({ status: "absent" });
  });
});

describe("S2 overlapping ensure_worker calls", () => {
  it("is witnessed when a second call starts before the first returns", () => {
    expect(s2OverlappingEnsureWitness(h(ensureCall(0, "c1"), ensureCall(100, "c2"), ensureResult(200, "c1", "created")))).toMatchObject({ status: "witnessed" });
  });
  it("is absent when calls run one after another", () => {
    expect(s2OverlappingEnsureWitness(h(ensureCall(0, "c1"), ensureResult(100, "c1", "created"), ensureCall(200, "c2")))).toEqual({ status: "absent" });
  });
});

describe("S3 crash before record", () => {
  const pane: Step = [0, { kind: "pane.create", pane: { paneId: "p1", shellPid: 10 } }];
  it("is witnessed when the shell dies before any record", () => {
    expect(s3CrashBeforeRecordWitness(h(pane, death(10, "w1", 10)))).toMatchObject({ status: "witnessed" });
  });
  it("is absent when a record is written before the shell dies", () => {
    const record: Step = [5, { kind: "durable.runtime", team, path: "runtime/w1.json", record: { raw: {}, membershipId: "m1" } }];
    expect(s3CrashBeforeRecordWitness(h(pane, record, death(10, "w1", 10)))).toEqual({ status: "absent" });
  });
});

describe("S4 Herdr loss during launch", () => {
  const herdrFault = (at: number): Step => [at, { kind: "fault.set", fault: { source: "herdr", mode: "unavailable" } }];
  it("is witnessed when a Herdr fault hits an outstanding ensure_worker call", () => {
    expect(s4HerdrLossInLaunchWitness(h(ensureCall(0, "c1"), herdrFault(100), ensureResult(200, "c1", "created")))).toMatchObject({ status: "witnessed" });
  });
  it("is absent when the fault arrives after the call returns", () => {
    expect(s4HerdrLossInLaunchWitness(h(ensureCall(0, "c1"), ensureResult(100, "c1", "created"), herdrFault(200)))).toEqual({ status: "absent" });
  });
});

describe("S5 compaction after a Team update", () => {
  const compact = (at: number): Step => [at, { kind: "world.input", input: 0, step: { kind: "pi.compact", who: lead } }];
  it("is witnessed when Pi compacts after a Team-update entry", () => {
    expect(s5CompactionAfterUpdateWitness(h(stamp(0, 0, 1), compact(10)))).toMatchObject({ status: "witnessed" });
  });
  it("is absent when compaction happens before the update", () => {
    expect(s5CompactionAfterUpdateWitness(h(compact(0), stamp(10, 0, 1)))).toEqual({ status: "absent" });
  });
});

describe("S6 suspected human stop", () => {
  it("is witnessed when a journal row marks suspectedHumanStop true", () => {
    expect(s6SuspectedHumanStopWitness(h(row(0, { paneId: "p1", suspectedHumanStop: true })))).toMatchObject({ status: "witnessed" });
  });
  it("is absent when every row marks suspectedHumanStop false", () => {
    expect(s6SuspectedHumanStopWitness(h(row(0, { paneId: "p1", suspectedHumanStop: false })))).toEqual({ status: "absent" });
  });
});
