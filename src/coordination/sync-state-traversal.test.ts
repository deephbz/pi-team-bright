import { describe, expect, it, vi } from "vitest";
import { CoordinationObservationService } from "./observation-service";
import { taskProjectionRevision } from "./task-projection-revision";
import type { CanonicalTaskCard } from "../task-authority/task-domain";
import type { TeamEvent } from "./contracts";
import type { CoordinationHiddenObservationCommit, CoordinationHiddenObservationCommitResult, CoordinationHiddenObservationProjection, CoordinationLeaderBindingEvidence } from "./queries";

// Contract rows run through the production service. No timers or operating-system evidence is needed.
const session = "/sessions/traversal-lead.jsonl";
const task: CanonicalTaskCard = { id: "work", title: "Work", goal: "Finish", current_context: "Initial", status: "open", version: "v_1" };
type State = "active" | "settled" | "absent" | "unknown-runtime" | "unknown-delivery";
type Worker = { name: string; state: State; pending: boolean };

function fixture(input: { workers?: Worker[]; events?: TeamEvent[]; changed?: boolean; waitSeconds?: number; missingBaseline?: boolean; wait?: (round: number) => void } = {}) {
  const workers = structuredClone(input.workers ?? []);
  const events = [...(input.events ?? [])];
  let tasks = [{ ...task, ...(input.changed ? { version: "v_2", current_context: "Changed" } : {}) }];
  let epochId = "epoch-1";
  let membershipId = "leader-1";
  let hidden: CoordinationHiddenObservationProjection = {
    schema: "pi-teams-hidden-observation/1", teamEpochId: epochId, exactSessionId: session,
    acknowledgedEntryId: "base", acknowledgedLineage: ["base"], teamEventCursor: "0",
    authorityRevisions: { task_projection: taskProjectionRevision([task], []), team_events: "0" }, updatedAt: "2026-10-07T00:00:00Z",
  };
  const binding = (): CoordinationLeaderBindingEvidence => ({
    teamName: "traversal", epochId, sessionFile: session, syncLiveness: { waitSeconds: input.waitSeconds ?? 1 },
    logicalWorkers: workers.map(({ name }) => ({ name, scope: "Traversal" })),
    members: [{ name: "team-lead", agentType: "lead", membershipId, sessionFile: session, isActive: true },
      ...workers.map((worker) => ({ name: worker.name, agentType: "teammate", membershipId: `member-${worker.name}`, isActive: true,
        ...(worker.state === "absent" ? {} : { sessionFile: `/sessions/${worker.name}.jsonl` }) }))],
  });
  const readEvents = vi.fn((_team: string, options?: { afterCursor?: string }) => {
    const unseen = events.filter((event) => Number(event.cursor) > Number(options?.afterCursor ?? "0"));
    const page = unseen.slice(0, 1);
    return { events: page, cursor: page.at(-1)?.cursor ?? String(events.length), headCursor: String(events.length), truncated: unseen.length > page.length, remaining: unseen.length - page.length };
  });
  const readHidden = vi.fn(async () => input.missingBaseline
    ? { kind: "not_found" as const, reason: "absent" as const }
    : { kind: "found" as const, projection: hidden });
  const commitHidden = vi.fn(async (_team: string, commit: CoordinationHiddenObservationCommit): Promise<CoordinationHiddenObservationCommitResult> => {
    hidden = { ...hidden, acknowledgedEntryId: commit.acknowledgedEntryId, acknowledgedLineage: commit.branchLineage, teamEventCursor: commit.teamEventCursor, authorityRevisions: commit.authorityRevisions ?? hidden.authorityRevisions };
    return { kind: "committed" as const, projection: hidden };
  });
  const readTasks = vi.fn(async () => tasks.map((task) => ({ kind: "found" as const, task })));
  const wait = vi.fn(async () => {
    const round = wait.mock.calls.length;
    if (round > 5) throw new Error("Traversal exceeded five waits");
    input.wait?.(round);
    return "timeout" as const;
  });
  const service = new CoordinationObservationService({
    teamRuntime: {
      readLeaderBinding: async () => binding(),
      readRuntime: async (_team, member) => {
        const worker = workers.find((worker) => worker.name === member.name)!;
        return worker.state === "unknown-runtime" || worker.state === "absent" ? null
          : { membershipId: member.membershipId, pid: 42, startedAt: 1, runState: worker.state === "active" ? "active" : "settled" };
      },
    },
    taskStateDelivery: {
      completeTaskSet: () => true, listTaskIds: async () => tasks.map((task) => task.id), readTasks,
      readDeliveryEvidence: async (_team, name) => { const worker = workers.find((worker) => worker.name === name)!; return { known: worker.state !== "unknown-delivery", pending: worker.pending }; },
    },
    alertActuation: { readInboxEvidence: async () => ({ known: true, pending: false }) },
  }, {
    projectNonterminalTaskIds: () => [],
    projectTaskChanges: (events, tasks) => ({ kind: "projected", changes: events.filter((event) => event.type === "task").map((event) => ({ taskId: event.ref.taskId, changeKinds: ["progress"], journalEntries: [], current: tasks.find((task) => task.id === event.ref.taskId)! })) }),
  }, {
    readHidden, commitHidden, readEvents, readEventCursor: () => String(events.length),
    waitEvents: async () => ({ ...readEvents("traversal"), timedOut: true }),
    readFailureHints: () => ({ hints: [], cursor: "0", headCursor: "0" }),
  }, { waitForLivenessHint: wait });
  service.setBranchContext(session, ["base"]);
  return { service, workers, events, wait, readTasks, readEvents, readHidden, commitHidden,
    hidden: () => structuredClone(hidden), setTasks: (value: typeof tasks) => { tasks = value; },
    replaceLeader: () => { membershipId = "leader-2"; }, replaceEpoch: () => { epochId = "epoch-2"; }, restoreEpoch: () => { epochId = "epoch-1"; } };
}
const observe = (fx: ReturnType<typeof fixture>, id: string, view: "snapshot" | "updates" = "updates", signal = new AbortController().signal) => fx.service.readTeamSync(session, view, signal, id);
const taskEvent = (cursor = "1", version: `v_${string}` = "v_1"): TeamEvent => ({ type: "task", cursor, ref: { taskId: task.id, version }, change: "status", actor: "worker", at: "2026-10-07T00:00:00Z" });
const emptyEvent: TeamEvent = { type: "worker", cursor: "1", worker: "retired", membershipId: "retired-member", phase: "stopped", at: "2026-10-07T00:00:00Z" };

// Independent contract oracle: reason comes from the input evidence, not the production liveness projection.
function unresolved(workers: Worker[]) {
  return workers.flatMap((worker) => {
    const reason = worker.state === "active" ? "still_active" : worker.pending ? "actuation_pending"
      : worker.state === "unknown-runtime" ? "run_state_unknown" : worker.state === "unknown-delivery" ? "delivery_state_unknown" : undefined;
    return reason ? [{ name: worker.name, reason }] : [];
  });
}
const evidence = (["active", "settled", "absent", "unknown-runtime", "unknown-delivery"] as State[])
  .flatMap((state) => [false, true].map((pending) => ({ state, pending })));
const combinations = [[], ...evidence.map((a) => [a]), ...evidence.flatMap((a) => evidence.map((b) => [a, b]))];
const rows = combinations.flatMap((combination) => [false, true].flatMap((event) => [false, true].flatMap((changed) => [0, 1].map((waitSeconds) => {
  const workers = combination.map((worker, index) => ({ ...worker, name: `worker-${index}` }));
  const final = workers.map((worker) => worker.state === "active" && waitSeconds > 0 ? { ...worker, state: "settled" as const, pending: false } : worker);
  const kind = event || changed ? "updates" : unresolved(final).length ? "unsettled" : "caught_up";
  return { id: `L[${workers.map((worker) => `${worker.state}:p${Number(worker.pending)}`).join("+") || "none"}]-e${Number(event)}-t${Number(changed)}-w${waitSeconds}`, workers, final, event, changed, waitSeconds, kind, diverges: kind === "unsettled" };
}))));

describe("team_sync contract state traversal (revision 2)", () => {
  for (const row of rows) {
    (row.diverges ? it.fails : it)(row.id, async () => {
      let fx!: ReturnType<typeof fixture>;
      fx = fixture({ workers: row.workers, events: row.event ? [taskEvent("1", row.changed ? "v_2" : "v_1")] : [], changed: row.changed, waitSeconds: row.waitSeconds,
        wait: (round) => { if (round === 2 && row.waitSeconds > 0) fx.workers.forEach((worker) => { if (worker.state === "active") { worker.state = "settled"; worker.pending = false; } }); } });
      const result: any = await observe(fx, row.id);
      expect(result.kind).toBe(row.kind);
      if (row.kind === "updates") expect(result.taskChanges).toMatchObject([{ taskId: task.id }]);
      if (row.kind === "unsettled") expect(result.workers).toEqual(unresolved(row.final));
      expect(fx.service.pending(session)).toMatchObject({ toolCallId: row.id, head: Number(row.event) });
      expect(fx.commitHidden).not.toHaveBeenCalled();
      const mustWait = !row.event && !row.changed && row.workers.some((worker) => worker.state === "active" || worker.pending);
      if (mustWait) expect(fx.wait.mock.calls.length).toBeGreaterThan(0);
      else expect(fx.wait).not.toHaveBeenCalled();
      expect(await fx.service.acknowledge(session, "result", ["base", "result"])).toBe(true);
      expect(fx.hidden().teamEventCursor).toBe(String(Number(row.event)));
      expect(fx.service.pending(session)).toBeUndefined();
    });
  }
});

// Both kinds are already representable by base types. Commit 2 flips only the expected-failure marker.
describe("team_sync named branch traversal", () => {
  for (const state of ["none", "settled", "active"] as const) for (const page of ["retired-worker", "stale-task"] as const) {
    it.fails(`B8-empty-${page}-authority-change-${state}`, async () => {
      const fx = fixture({ workers: state === "none" ? [] : [{ name: "worker", state, pending: false }], changed: true,
        events: [page === "retired-worker" ? emptyEvent : taskEvent()] });
      const result: any = await observe(fx, "changed-after-empty");
      expect(result).toMatchObject({ kind: "updates", taskChanges: [{ taskId: task.id, current: { version: "v_2", current_context: "Changed" } }] });
      expect(fx.wait).not.toHaveBeenCalled();
      expect(fx.service.pending(session)).toMatchObject({ head: 1, baselineCursor: "0" });
      expect(await fx.service.acknowledge(session, "changed-entry", ["base", "changed-entry"])).toBe(true);
      expect(fx.hidden().authorityRevisions.task_projection).toBe(taskProjectionRevision(result.taskChanges.map((change: any) => change.current), []));
      expect(fx.hidden().teamEventCursor).toBe("1");
    });
  }
  for (const state of ["none", "settled", "active"] as const) {
    it.fails(`B8-empty-page-pure-removal-${state}`, async () => {
      const fx = fixture({ workers: state === "none" ? [] : [{ name: "worker", state, pending: false }], events: [emptyEvent] });
      fx.setTasks([]);
      expect(await observe(fx, "removed-after-empty")).toMatchObject({ kind: "snapshot", tasks: [], head: 1 });
      expect(fx.wait).not.toHaveBeenCalled();
      expect(await fx.service.acknowledge(session, "removed-entry", ["base", "removed-entry"])).toBe(true);
      expect(fx.hidden().authorityRevisions.task_projection).toBe(taskProjectionRevision([], []));
      expect(fx.hidden().teamEventCursor).toBe("1");
    });
  }
  it.fails("B7-updates-without-baseline-stages-snapshot", async () => {
    const fx = fixture({ missingBaseline: true });
    expect(await observe(fx, "missing")).toMatchObject({ kind: "snapshot", tasks: [{ id: task.id }] });
    expect(fx.service.pending(session)?.toolCallId).toBe("missing");
  });
  it.fails("B10-sequential-duplicate-refused", async () => {
    const fx = fixture();
    const first = await observe(fx, "first", "snapshot");
    expect(await observe(fx, "first", "snapshot")).toEqual(first);
    expect(await observe(fx, "second", "snapshot")).toMatchObject({ kind: "refused", reason: "observation_in_progress" });
    expect(fx.service.pending(session)?.toolCallId).toBe("first");
  });
  it.fails("B3-parallel-duplicate-refused", async () => {
    const fx = fixture();
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    fx.readTasks.mockImplementationOnce(async () => { entered(); await blocked; return [{ kind: "found", task }]; });
    const first = observe(fx, "first", "snapshot");
    await reached;
    const duplicate = await observe(fx, "second", "snapshot");
    release();
    await first;
    expect(duplicate).toMatchObject({ kind: "refused", reason: "observation_in_progress" });
    expect(fx.service.pending(session)?.toolCallId).toBe("first");
  });
  for (const state of ["active", "settled"] as const) for (const later of [false, true]) {
    it.fails(`B8-native-empty-page-${state}-later${Number(later)}`, async () => {
      let fx!: ReturnType<typeof fixture>;
      fx = fixture({ workers: [{ name: "worker", state, pending: false }], events: [emptyEvent, ...(later ? [taskEvent("2")] : [])],
        wait: () => { fx.workers[0].state = "settled"; } });
      const result: any = await observe(fx, "empty-page");
      expect(result.kind).toBe(later ? "updates" : "caught_up");
      if (later) expect(result.taskChanges).toMatchObject([{ taskId: task.id }]);
      expect(fx.service.pending(session)?.head).toBe(later ? 2 : 1);
      if (state === "active" && !later) expect(fx.wait).toHaveBeenCalled();
      expect(fx.commitHidden).not.toHaveBeenCalled();
    });
  }
});


describe("team_sync acknowledgement and wait transitions", () => {
  for (const failure of ["branch", "epoch", "membership", "commit-refused", "commit-throws"] as const) {
    it.fails(`B2-${failure}-releases-pending-and-reprojects`, async () => {
      const fx = fixture({ events: [taskEvent()] });
      const before = fx.hidden();
      expect((await observe(fx, "first")).kind).toBe("updates");
      if (failure === "epoch") fx.replaceEpoch();
      if (failure === "membership") fx.replaceLeader();
      if (failure === "commit-refused") fx.commitHidden.mockResolvedValueOnce({ kind: "refused", reason: "stale_acknowledgement" });
      if (failure === "commit-throws") fx.commitHidden.mockRejectedValueOnce(new Error("Injected commit failure"));
      const acknowledgement = fx.service.acknowledge(session, "result", failure === "branch" ? ["base"] : ["base", "result"]);
      if (failure === "commit-throws") await expect(acknowledgement).rejects.toThrow("Injected commit failure");
      else expect(await acknowledgement).toBe(false);
      expect(fx.hidden()).toEqual(before);
      if (failure === "epoch") fx.restoreEpoch();
      const next = await observe(fx, "second");
      expect(next).toMatchObject({ kind: "updates", taskChanges: [{ taskId: task.id }] });
      expect(fx.service.pending(session)).toMatchObject({ toolCallId: "second", baselineCursor: "0", head: 1 });
    });
  }
  it("page-cursor-never-commits-an-unread-later-page", async () => {
    const fx = fixture({ events: [taskEvent(), taskEvent("2")] });
    const first: any = await observe(fx, "first");
    expect(first).toMatchObject({ kind: "updates", head: 1, taskChanges: [{ taskId: task.id }] });
    expect(fx.service.pending(session)?.head).toBe(1);
    expect(await fx.service.acknowledge(session, "first-entry", ["base", "first-entry"])).toBe(true);
    expect(fx.hidden().teamEventCursor).toBe("1");
    fx.service.setBranchContext(session, ["base", "first-entry"]);
    expect(await observe(fx, "second")).toMatchObject({ kind: "updates", head: 2, taskChanges: [{ taskId: task.id }] });
  });
  it("failed-authority-read-cannot-stage-or-commit-an-observation", async () => {
    const fx = fixture();
    const before = fx.hidden();
    fx.readTasks.mockRejectedValueOnce(new Error("Injected authority read failure"));
    expect(await observe(fx, "failed-read")).toMatchObject({ kind: "unavailable", reason: "task_authority_unavailable" });
    expect(fx.service.pending(session)).toBeUndefined();
    expect(fx.commitHidden).not.toHaveBeenCalled();
    expect(fx.hidden()).toEqual(before);
  });
  it("discard-only-the-captured-call-preserves-a-newer-candidate", async () => {
    const fx = fixture();
    await observe(fx, "old", "snapshot");
    fx.service.discardPending(session, "old");
    await observe(fx, "new", "snapshot");
    fx.service.discardPending(session, "old");
    expect(fx.service.pending(session)?.toolCallId).toBe("new");
    expect(fx.hidden().acknowledgedEntryId).toBe("base");
  });
  for (const waitSeconds of [0, 1]) for (const transition of ["settle", "clear-actuation", "event", "task", "abort", "binding"] as const) {
    it(`W-${transition}-w${waitSeconds}`, async () => {
      const controller = new AbortController();
      let fx!: ReturnType<typeof fixture>;
      fx = fixture({ workers: [{ name: "worker", state: transition === "clear-actuation" ? "settled" : "active", pending: transition === "clear-actuation" }], waitSeconds,
        wait: () => {
          if (transition === "settle") fx.workers[0].state = "settled";
          if (transition === "clear-actuation") fx.workers[0].pending = false;
          if (transition === "event") fx.events.push(taskEvent());
          if (transition === "task") fx.setTasks([{ ...task, version: "v_2", current_context: "During wait" }]);
          if (transition === "abort") controller.abort();
          if (transition === "binding") fx.replaceLeader();
        } });
      const result = await observe(fx, "transition", "updates", controller.signal);
      const kind = ["settle", "clear-actuation"].includes(transition) ? "caught_up"
        : ["event", "task"].includes(transition) ? "updates" : transition === "abort" ? "cancelled" : "unavailable";
      expect(result.kind).toBe(kind);
      expect(fx.wait).toHaveBeenCalledOnce();
      expect(fx.commitHidden).not.toHaveBeenCalled();
      if (kind === "cancelled" || kind === "unavailable") expect(fx.service.pending(session)).toBeUndefined();
      else expect(fx.service.pending(session)?.toolCallId).toBe("transition");
    });
  }
  it("W-active-and-unknown-delivery-become-settled-together", async () => {
    let fx!: ReturnType<typeof fixture>;
    fx = fixture({ workers: [{ name: "active", state: "active", pending: false }, { name: "incomplete", state: "unknown-delivery", pending: false }],
      wait: () => fx.workers.forEach((worker) => { worker.state = "settled"; }) });
    expect((await observe(fx, "complete")).kind).toBe("caught_up");
    expect(fx.wait).toHaveBeenCalledOnce();
  });
});
