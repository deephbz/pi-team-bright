import { describe, expect, it, vi } from "vitest";
import { CoordinationObservationService } from "./observation-service";
import { taskProjectionRevision } from "./task-projection-revision";
import type { CanonicalTaskCard } from "../task-authority/task-domain";
import type { TeamEvent } from "./contracts";
import type { CoordinationHiddenObservationCommit, CoordinationHiddenObservationProjection } from "./queries";

const sessionFile = "/sessions/lead-sync-continuity.jsonl";
const task: CanonicalTaskCard = {
  id: "task-open", title: "Unfinished Task", goal: "Complete work", current_context: "Work remains",
  status: "open", version: "v_1",
};

function fixture(options: { tasks?: CanonicalTaskCard[]; workers?: string[]; runtime?: "active" | "settled" | "unknown"; pending?: boolean; events?: TeamEvent[]; baselineTasks?: CanonicalTaskCard[]; waitSeconds?: number; wait?: () => Promise<"hint" | "timeout">; pageSize?: number; singleScan?: boolean } = {}) {
  let tasks = options.tasks ?? [task];
  const workers = options.workers ?? ["worker"];
  let runState = options.runtime ?? "settled";
  let pending = options.pending ?? false;
  let leadMembership = "lead-1";
  let workerMembership = "worker-1";
  let epochId = "epoch-1";
  const binding = () => ({
    teamName: "team-sync-continuity", epochId, sessionFile,
    syncLiveness: { waitSeconds: options.waitSeconds ?? 1 },
    logicalWorkers: workers.map((name) => ({ name, scope: "fixture" })),
    members: [
      { name: "team-lead", agentType: "lead", membershipId: leadMembership, sessionFile, isActive: true },
      ...workers.map((name) => ({ name, agentType: "teammate", membershipId: workerMembership, sessionFile: `/sessions/${name}.jsonl`, isActive: true })),
    ],
  });
  const events = options.events ?? [];
  const readEvents = vi.fn((_team: string, input?: { afterCursor?: string }) => {
    const unseen = events.filter((event) => Number(event.cursor) > Number(input?.afterCursor ?? "0"));
    const page = unseen.slice(0, options.pageSize ?? 1);
    return {
      events: page, cursor: page.length ? page.at(-1)!.cursor : String(events.length),
      headCursor: String(events.length), truncated: unseen.length > page.length,
      remaining: unseen.length - page.length,
    };
  });
  const readEventPages = vi.fn((_team: string, input?: { afterCursor?: string }) => {
    const unseen = events.filter((event) => Number(event.cursor) > Number(input?.afterCursor ?? "0"));
    const pageSize = options.pageSize ?? 1;
    if (unseen.length === 0) return [{ events: [], cursor: String(events.length), headCursor: String(events.length), truncated: false, remaining: 0 }];
    const pages = [];
    for (let offset = 0; offset < unseen.length; offset += pageSize) {
      const page = unseen.slice(offset, offset + pageSize);
      const remaining = unseen.length - offset - page.length;
      pages.push({ events: page, cursor: remaining ? page.at(-1)!.cursor : String(events.length), headCursor: String(events.length), truncated: remaining > 0, remaining });
    }
    return pages;
  });
  const baseline = options.baselineTasks ?? tasks;
  let hidden: CoordinationHiddenObservationProjection = {
    schema: "pi-teams-hidden-observation/1" as const,
    teamEpochId: "epoch-1", exactSessionId: sessionFile,
    acknowledgedEntryId: "base", acknowledgedLineage: ["base"],
    teamEventCursor: "0", authorityRevisions: { task_projection: taskProjectionRevision(baseline, []), team_events: "0" },
    updatedAt: "2026-09-26T00:00:00.000Z",
  };
  const commitHidden = vi.fn(async (_team: string, input: CoordinationHiddenObservationCommit) => {
    hidden = { ...hidden, teamEventCursor: input.teamEventCursor, acknowledgedEntryId: input.acknowledgedEntryId, acknowledgedLineage: input.branchLineage, authorityRevisions: input.authorityRevisions ?? hidden.authorityRevisions };
    return { kind: "committed" as const, projection: hidden };
  });
  const waitForLivenessHint = vi.fn(options.wait ?? (async () => "timeout" as const));
  const readTasks = vi.fn(async (_team: string, ids: string[]) => ids.map((id) => ({ kind: "found" as const, task: tasks.find((item) => item.id === id)! })));
  const service = new CoordinationObservationService({
    teamRuntime: {
      readLeaderBinding: vi.fn(async () => binding()),
      readRuntime: vi.fn(async () => runState === "unknown" ? null : ({ membershipId: workerMembership, pid: 42, startedAt: 1, runState })),
    },
    taskStateDelivery: {
      listTaskIds: vi.fn(async () => tasks.map((item) => item.id)),
      readTasks,
      readDeliveryEvidence: vi.fn(async () => ({ known: true, pending })),
    },
    alertActuation: { readInboxEvidence: vi.fn(async () => ({ known: true, pending: false })) },
  }, {
    projectNonterminalTaskIds: () => [],
    projectTaskChanges: (input, current) => ({ kind: "projected" as const, changes: [...new Set(input.filter((event) => event.type === "task").map((event) => event.ref.taskId))].map((id) => ({ taskId: id, changeKinds: ["progress" as const], journalEntries: [], current: current.find((item) => item.id === id)! })) }),
  }, {
    readHidden: vi.fn(async () => ({ kind: "found" as const, projection: hidden })),
    commitHidden,
    readEvents,
    ...(options.singleScan ? { readEventPages } : {}),
    readEventCursor: vi.fn(() => String(events.length)),
    waitEvents: vi.fn(async () => ({ ...readEvents("team-sync-continuity", { afterCursor: "0" }), timedOut: true })),
    readFailureHints: vi.fn(() => ({ hints: [], cursor: "0", headCursor: "0" })),
  }, { waitForLivenessHint } as any);
  service.setBranchContext(sessionFile, ["base"]);
  return { service, waitForLivenessHint, commitHidden, readEvents, readEventPages, readTasks, setTasks: (value: CanonicalTaskCard[]) => { tasks = value; }, setRunState: (value: typeof runState) => { runState = value; }, setPending: (value: boolean) => { pending = value; }, setLeadMembership: (value: string) => { leadMembership = value; }, setWorkerMembership: (value: string) => { workerMembership = value; }, setEpoch: (value: string) => { epochId = value; } };
}

describe("Team synchronization continuity", () => {
  it("keeps one selected wait alive across internal deadlines while the exact Worker stays active", async () => {
    let rounds = 0;
    let fx!: ReturnType<typeof fixture>;
    fx = fixture({ runtime: "active", wait: async () => { rounds++; if (rounds === 3) fx.setRunState("settled"); return "timeout"; } });
    const result = await fx.service.readTeamSync(sessionFile, "updates", new AbortController().signal, "call-1");
    expect(result.kind).toBe("caught_up");
    expect(fx.waitForLivenessHint).toHaveBeenCalledTimes(3);
    expect(fx.service.pending(sessionFile)?.toolCallId).toBe("call-1");
    expect(fx.commitHidden).not.toHaveBeenCalled();
  });

  it("gives pending-only actuation one bounded interval, then returns indeterminate", async () => {
    const fx = fixture({ runtime: "unknown", pending: true });
    const result = await fx.service.readTeamSync(sessionFile, "updates", new AbortController().signal, "pending");
    expect(result.kind).toBe("indeterminate");
    expect(fx.waitForLivenessHint).toHaveBeenCalledOnce();
    expect(fx.service.pending(sessionFile)).toBeUndefined();
  });

  it("performs only one immediate check when wait_seconds is zero", async () => {
    const fx = fixture({ runtime: "active", waitSeconds: 0 });
    const result = await fx.service.readTeamSync(sessionFile, "updates", new AbortController().signal, "zero-wait");
    expect(result.kind).toBe("indeterminate");
    expect(fx.waitForLivenessHint).toHaveBeenCalledOnce();
    expect(fx.service.pending(sessionFile)).toBeUndefined();
  });

  it("cancels after an internal interval without staging a cursor", async () => {
    const controller = new AbortController();
    const fx = fixture({ runtime: "active", wait: async () => { controller.abort(); return "timeout"; } });
    expect((await fx.service.readTeamSync(sessionFile, "updates", controller.signal, "aborted")).kind).toBe("cancelled");
    expect(fx.service.pending(sessionFile)).toBeUndefined();
    expect(fx.commitHidden).not.toHaveBeenCalled();
  });

  it("returns a quiet immediate observation for a settled Worker with an unfinished Task", async () => {
    const fx = fixture();
    expect(await fx.service.readTeamSyncNow(sessionFile, "updates", new AbortController().signal, "now")).toEqual({ kind: "quiet" });
    expect((await fx.service.peekTeamSync(sessionFile, "updates", ["base"])).kind).toBe("quiet");
    expect(fx.waitForLivenessHint).not.toHaveBeenCalled();
    expect(fx.service.pending(sessionFile)).toBeUndefined();
  });

  it("keeps an empty initial snapshot out of model context", async () => {
    const fx = fixture({ workers: [], tasks: [] });
    expect(await fx.service.readTeamSyncNow(sessionFile, "snapshot", new AbortController().signal, "empty-snapshot")).toEqual({ kind: "quiet" });
    expect(await fx.service.peekTeamSync(sessionFile, "snapshot", ["base"])).toMatchObject({ kind: "quiet", updateCount: 0 });
    expect(fx.service.pending(sessionFile)).toBeUndefined();
  });

  it("does not reuse a pre-commit probe read for a post-commit snapshot baseline", async () => {
    const events: TeamEvent[] = [
      { type: "task", cursor: "1", ref: { taskId: task.id, version: "v_1" }, change: "status", actor: "team-lead", at: "2026-09-26T00:00:00Z" },
    ];
    const fx = fixture({ tasks: [], events });
    let release!: (value: []) => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    fx.readTasks.mockImplementationOnce(async () => { entered(); return new Promise((resolve) => { release = resolve; }); });
    const preCommitRead = fx.service.readTaskProjection("team-sync-continuity");
    await reached;
    fx.setTasks([task]);
    const selected = fx.service.readTeamSync(sessionFile, "snapshot", new AbortController().signal, "post-commit");
    release([]);
    expect((await preCommitRead).kind).toBe("tasks");
    expect(await selected).toMatchObject({ kind: "snapshot", tasks: [{ id: task.id }], workers: [{ nonterminalTaskIds: [] }] });
    expect(fx.service.pending(sessionFile)?.head).toBe(1);
    expect(await fx.service.acknowledge(sessionFile, "snapshot-entry", ["base", "snapshot-entry"])).toBe(true);
    expect((await fx.service.peekTeamSync(sessionFile, "updates", ["base", "snapshot-entry"])).kind).toBe("quiet");
  });

  it("reads past a leader-only first page and counts one external canonical Task change", async () => {
    const leadTask = { ...task, id: "lead-task" };
    const externalTask = { ...task, id: "external-task" };
    const events: TeamEvent[] = [
      { type: "task", cursor: "1", ref: { taskId: "lead-task", version: "v_1" }, change: "status", actor: "team-lead", at: "2026-09-26T00:00:00Z" },
      { type: "task", cursor: "2", ref: { taskId: "external-task", version: "v_1" }, change: "status", actor: "worker", at: "2026-09-26T00:00:01Z" },
    ];
    const fx = fixture({ tasks: [leadTask, externalTask], events });
    const probe = await fx.service.peekTeamSync(sessionFile, "updates", ["base"]);
    expect(probe).toMatchObject({ kind: "prepared", updateCount: 0, continuationEligible: true, result: { kind: "updates", head: 1, taskChanges: [{ taskId: "lead-task" }] } });
    expect(fx.service.pending(sessionFile)).toBeUndefined();
    expect(fx.readEvents).toHaveBeenCalledWith("team-sync-continuity", { afterCursor: "1" });
  });

  it("skips a canonically empty page without presenting it or losing a later update", async () => {
    const events: TeamEvent[] = [
      ...Array.from({ length: 50 }, (_, index): TeamEvent => ({
        type: "worker", cursor: String(index + 1), worker: "retired-worker", membershipId: "retired-member",
        phase: "stopped", at: "2026-09-26T00:00:00Z",
      })),
      { type: "task", cursor: "51", ref: { taskId: task.id, version: "v_1" }, change: "status", actor: "worker", at: "2026-09-26T00:00:01Z" },
    ];
    const fx = fixture({ events, pageSize: 50, singleScan: true });
    const probe = await fx.service.peekTeamSync(sessionFile, "updates", ["base"]);
    expect(probe).toMatchObject({ kind: "prepared", updateCount: 1, result: { kind: "updates", head: 51, taskChanges: [{ taskId: task.id }] } });
    const selected = await fx.service.readTeamSyncNow(sessionFile, "updates", new AbortController().signal, "after-empty");
    expect(selected).toEqual(probe.kind === "prepared" ? probe.result : undefined);
    expect(fx.service.pending(sessionFile)?.head).toBe(51);
    expect(fx.readEvents).not.toHaveBeenCalled();
  });

  it("presents a large backlog in bounded pages and continues after each exact acknowledgement", async () => {
    const cards = Array.from({ length: 251 }, (_, index) => ({ ...task, id: `task-${index}` }));
    const events: TeamEvent[] = cards.map((card, index) => ({
      type: "task", cursor: String(index + 1), ref: { taskId: card.id, version: "v_1" },
      change: "status", actor: index === 250 ? "worker" : "team-lead", at: "2026-09-26T00:00:00Z",
    }));
    const fx = fixture({ tasks: cards, events, pageSize: 50, singleScan: true });
    const presentedHeads: number[] = [];
    const scopeKeys: string[] = [];
    let branch = ["base"];
    for (let index = 0; index < 6; index++) {
      fx.service.setBranchContext(sessionFile, branch);
      const probe = await fx.service.peekTeamSync(sessionFile, "updates", branch);
      expect(probe.kind).toBe("prepared");
      if (probe.kind !== "prepared") throw new Error("Expected one bounded canonical page.");
      expect(probe.result.kind).toBe("updates");
      if (probe.result.kind !== "updates") throw new Error("Expected Team updates.");
      expect(probe.result.taskChanges.length).toBeLessThanOrEqual(50);
      expect(probe.updateCount).toBe(index === 5 ? 1 : 0);
      expect(probe.continuationEligible).toBe(index === 5 ? undefined : true);
      scopeKeys.push(probe.scopeKey);
      const selected = await fx.service.readTeamSyncNow(sessionFile, "updates", new AbortController().signal, `call-${index}`);
      expect(selected).toEqual(probe.result);
      if (selected.kind !== "updates") throw new Error("Expected selected Team updates.");
      presentedHeads.push(selected.head);
      expect(fx.service.pending(sessionFile)).toMatchObject({
        baselineCursor: index === 0 ? "0" : String(presentedHeads[index - 1]),
        baselineAcknowledgedEntryId: index === 0 ? "base" : `entry-${index - 1}`,
      });
      const entryId = `entry-${index}`;
      branch = [...branch, entryId];
      expect(await fx.service.acknowledge(sessionFile, entryId, branch)).toBe(true);
    }
    expect(presentedHeads).toEqual([50, 100, 150, 200, 250, 251]);
    expect(new Set(scopeKeys).size).toBe(6);
    expect(fx.readEventPages).toHaveBeenCalledTimes(12);
    expect(fx.readEvents).not.toHaveBeenCalled();
    expect((await fx.service.peekTeamSync(sessionFile, "updates", branch)).kind).toBe("quiet");
  });

  it("counts a canonical Task authority revision without an event", async () => {
    const fx = fixture({ baselineTasks: [] });
    expect(await fx.service.peekTeamSync(sessionFile, "updates", ["base"])).toMatchObject({ kind: "prepared", updateCount: 1, result: { kind: "updates", taskChanges: [{ taskId: "task-open" }] } });
  });

  it("does not acknowledge a result after same-Session leader Membership replacement", async () => {
    const fx = fixture();
    expect((await fx.service.readTeamSync(sessionFile, "snapshot", new AbortController().signal, "snapshot")).kind).toBe("snapshot");
    fx.setLeadMembership("lead-2");
    expect(await fx.service.acknowledge(sessionFile, "result-entry", ["base", "result-entry"])).toBe(false);
    expect(fx.commitHidden).not.toHaveBeenCalled();
  });

  it("refuses a stale selected result when the leader Membership changes during Task hydration", async () => {
    const fx = fixture();
    let release!: (value: Array<{ kind: "found"; task: CanonicalTaskCard }>) => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    fx.readTasks.mockImplementationOnce(async () => { entered(); return new Promise((resolve) => { release = resolve; }); });
    const selected = fx.service.readTeamSyncNow(sessionFile, "snapshot", new AbortController().signal, "stale-selected");
    await reached;
    fx.setLeadMembership("lead-2");
    release([{ kind: "found", task }]);
    expect(await selected).toMatchObject({ kind: "unavailable", reason: "no_active_team" });
    expect(fx.service.pending(sessionFile)).toBeUndefined();
  });
});
