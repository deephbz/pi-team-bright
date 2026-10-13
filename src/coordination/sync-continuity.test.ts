import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinationObservationService, OBSERVATION_RESERVATION_MS } from "./observation-service";
import { readBranchObservation, TEAM_UPDATE_TYPE, type BranchEntry } from "./branch-observation";
import { persistObservation, snapshotEntry } from "../../test/support/branch-observation";
import type { CanonicalTaskCard } from "../task-authority/task-domain";
import type { TeamEvent } from "./contracts";

const file = "/sessions/lead.jsonl";
const task: CanonicalTaskCard = { id: "task", title: "Task", goal: "Do work", current_context: "Ready", status: "open", version: "v_1" };
function fixture() {
  let tasks = [task], membership = "lead", epoch = "epoch", authorized = true;
  let logicalWorkers = [{ name: "worker", scope: "work" }];
  let branch: BranchEntry[] = [snapshotEntry("base", "team", epoch, membership, tasks)];
  const events: TeamEvent[] = [];
  let onWatermark = () => {};
  const readTasks = vi.fn(async (_team: string, ids: readonly string[]) => ids.map(id => ({ kind: "found" as const, task: tasks.find(task => task.id === id)! })));
  const makeService = () => new CoordinationObservationService({
    teamRuntime: {
      readLeaderBinding: async (session) => authorized && session === file ? { teamName: "team", epochId: epoch, sessionFile: file, logicalWorkers: [...logicalWorkers], members: [{ name: "team-lead", agentType: "lead", membershipId: membership, sessionFile: file, isActive: true }], syncLiveness: { waitSeconds: 120 } } : undefined,
      readRuntime: async () => null,
    },
    taskStateDelivery: { listTaskIds: async () => tasks.map(task => task.id), readTasks, readDeliveryEvidence: async () => ({ known: true, pending: false }) },
    alertActuation: { readInboxEvidence: async () => ({ known: true, pending: false }) },
    receivedAlerts: { readRecentReceivedAlerts: async () => ({ alerts: [], omitted: 0 }) },
  }, {
    projectNonterminalTaskIds: () => [],
    projectTaskChanges: (events, current) => ({ kind: "projected", changes: events.flatMap(event => event.type === "task" ? current.filter(task => task.id === event.ref.taskId).map(task => ({ taskId: task.id, changeKinds: ["progress" as const], journalEntries: [], current: task })) : []) }),
  }, {
    readEventCursor: () => { onWatermark(); return String(events.length); },
    readEvents: (_team, options) => {
      const unseen = events.filter(event => Number(event.cursor) > Number(options?.afterCursor ?? 0));
      const page = unseen.slice(0, 1);
      return { events: page, cursor: page.at(-1)?.cursor ?? String(events.length), headCursor: String(events.length), truncated: unseen.length > page.length, remaining: unseen.length - page.length };
    },
  });
  let service = makeService();
  service.setBranchEntries(file, branch);
  const sync = (view: "snapshot" | "updates" = "updates", call = "call") => service.readTeamSync(file, view, new AbortController().signal, call);
  const append = () => events.push({ type: "worker", worker: "worker", membershipId: "worker-1", phase: "prepared", cursor: String(events.length + 1), at: "2026-10-12T00:00:00Z" });
  return { get service() { return service; }, get branch() { return branch; }, readTasks, events, sync, append,
    persist: (id = "result") => { branch = persistObservation(service, file, id, branch); },
    select: (entries: BranchEntry[]) => { branch = entries; service.setBranchEntries(file, branch); },
    restart: () => { service = makeService(); service.setBranchEntries(file, branch); },
    tasks: (next: CanonicalTaskCard[]) => { tasks = next; },
    noWorkers: () => { logicalWorkers = []; },
    workers: (next: typeof logicalWorkers) => { logicalWorkers = next; },
    onWatermark: (callback: () => void) => { onWatermark = callback; },
    bind: (next: string) => { membership = next; }, epoch: (next: string) => { epoch = next; }, unbind: () => { authorized = false; },
  };
}
afterEach(() => vi.useRealTimers());

describe("branch-held Team observation", () => {
  it.each([true, false])("projects idle Worker advice with in_progress Task=%s", async unfinished => {
    const fx = fixture();
    fx.tasks(unfinished ? [{ ...task, assignee: "worker", status: "in_progress" }] : []);
    fx.select([snapshotEntry("base", "team", "epoch", "lead", unfinished ? [{ ...task, assignee: "worker", status: "in_progress" }] : [])]);
    fx.events.push({ type: "worker", worker: "worker", membershipId: "worker-1", phase: "carrier", cursor: "1", at: "2026-10-12T00:00:00Z",
      carrier: { membership: "worker-1", observedAt: 1, field: "activity", from: "working", to: "idle", cause: { source: "herdr", fact: "agent_status=done" }, paneId: "pane-1", suspectedHumanStop: false, nextActionHint: "wait" } });
    const result = await fx.sync();
    expect(result.kind).toBe("updates");
    if (result.kind !== "updates") throw new Error("Expected Worker update");
    const text = result.workerChanges[0]!.text;
    if (unfinished) {
      expect(text).toContain("Inspect in_progress Task task and its blocker and evidence");
      expect(text).toContain("then decide whether to send a clarification Alert");
      expect(text).not.toMatch(/wait|ask_human|spawn|replace/i);
    } else {
      expect(text).toBe("Worker worker: activity idle; herdr: agent_status=done; pane pane-1; suspectedHumanStop=false; nextActionHint=wait; nonterminalTaskIds=none.");
    }
    expect(fx.events[0]).toMatchObject({ carrier: { nextActionHint: "wait" } });
    fx.service.clearPending(file);
  });
  it("commits only native persistence and stamps the page boundary, never the journal head", async () => {
    const fx = fixture(); fx.append(); fx.append();
    expect(await fx.sync()).toMatchObject({ kind: "updates", head: 1 });
    expect(fx.service.pending(file)?.observation).toEqual({ team: "team", epoch: "epoch", binding: "lead", from: 0, through: 1 });
    expect(await fx.sync("updates", "competitor")).toMatchObject({ kind: "refused", reason: "observation_in_progress" });
    fx.persist();
    expect(fx.service.pending(file)).toBeUndefined();
    expect(await fx.sync()).toMatchObject({ kind: "updates", head: 2 });
  });
  it("reserves before Task hydration so a competing call returns immediately", async () => {
    const fx = fixture();
    let release!: () => void;
    fx.readTasks.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return [{ kind: "found", task }]; });
    const first = fx.sync("snapshot");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(await fx.sync()).toMatchObject({ reason: "observation_in_progress" });
    release(); expect(await first).toMatchObject({ kind: "snapshot" });
  });
  it("expires a lost send without advancing the branch cursor", async () => {
    vi.useFakeTimers(); const fx = fixture(); fx.append();
    expect(await fx.sync()).toMatchObject({ head: 1 });
    await vi.advanceTimersByTimeAsync(OBSERVATION_RESERVATION_MS);
    expect(fx.service.pending(file)).toBeUndefined();
    expect(await fx.sync()).toMatchObject({ head: 1 });
  });
  it("fences a hydration result whose reservation expired", async () => {
    vi.useFakeTimers(); const fx = fixture(); let release!: () => void;
    fx.readTasks.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return [{ kind: "found", task }]; });
    const first = fx.sync("snapshot"); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(OBSERVATION_RESERVATION_MS); release();
    expect(await first).toMatchObject({ kind: "cancelled" });
    expect(fx.service.pending(file)).toBeUndefined();
  });
  it("replays a crash before persistence and retains delivery across a restart after persistence", async () => {
    const fx = fixture(); fx.append(); await fx.sync(); fx.restart();
    expect(await fx.sync()).toMatchObject({ kind: "updates", head: 1 });
    fx.persist(); fx.restart();
    expect(await fx.sync()).toMatchObject({ kind: "caught_up", head: 1 });
  });
  it("keeps the native cursor after compaction removes payload from model context", async () => {
    const fx = fixture(); fx.append(); await fx.sync(); fx.persist();
    fx.select([...fx.branch, { id: "compaction", type: "compaction" }]); fx.restart();
    expect(await fx.sync()).toMatchObject({ kind: "caught_up", head: 1 });
    fx.persist("caught-up");
    expect(await fx.sync("snapshot")).toMatchObject({ kind: "snapshot", tasks: [task] });
  });
  it("recomputes on tree navigation before an update and on a sibling branch", async () => {
    const fx = fixture(); const base = fx.branch; fx.append(); await fx.sync(); fx.persist();
    fx.select([...base, { id: "sibling", type: "message" }]);
    expect(await fx.sync()).toMatchObject({ kind: "updates", head: 1 });
    fx.select([]);
    expect(await fx.sync()).toMatchObject({ kind: "snapshot", head: 1 });
  });
  it("never lets copied fork entries authorize an unbound Session", async () => {
    const fx = fixture(); fx.append(); await fx.sync(); fx.persist();
    fx.service.setBranchEntries("/sessions/fork.jsonl", fx.branch);
    expect(await fx.service.readTeamSync("/sessions/fork.jsonl", "updates", new AbortController().signal, "fork")).toMatchObject({ reason: "no_active_team" });
  });
  it.each(["binding", "epoch"])("invalidates a reservation on %s replacement", async (scope) => {
    const fx = fixture(); fx.append(); await fx.sync();
    if (scope === "binding") fx.bind("replacement"); else fx.epoch("replacement");
    expect(await fx.sync()).toMatchObject({ kind: "snapshot" });
  });
  it("bootstraps a 50-event Team from unstamped pre-upgrade results without replaying updates", async () => {
    const fx = fixture(); for (let index = 0; index < 50; index++) fx.append();
    fx.select([{ id: "old-result", type: "message", message: { role: "toolResult", toolName: "team_sync", details: { kind: "snapshot", tasks: [task] } } }]);
    const first = await fx.sync();
    expect(first).toMatchObject({ kind: "snapshot", head: 50 });
    expect(first).not.toHaveProperty("workerChanges");
    expect(fx.service.pending(file)?.observation?.through).toBe(50);
    fx.persist(); fx.append();
    expect(await fx.sync()).toMatchObject({ kind: "updates", head: 51, workerChanges: [{ worker: "worker" }] });
    expect(fx.service.pending(file)?.observation?.from).toBe(50);
  });
  it("captures the snapshot watermark before Task hydration", async () => {
    const fx = fixture();
    fx.readTasks.mockImplementationOnce(async () => { fx.append(); return [{ kind: "found", task: { ...task, current_context: "Newer state" } }]; });
    expect(await fx.sync("snapshot")).toMatchObject({ head: 0, tasks: [{ current_context: "Newer state" }] });
    fx.persist();
    expect(await fx.sync()).toMatchObject({ kind: "updates", head: 1, workerChanges: [{ worker: "worker" }] });
  });
  it("reconciles Task authority changes with no journal event", async () => {
    const fx = fixture(); fx.tasks([{ ...task, version: "v_2", current_context: "Externally changed" }]);
    expect(await fx.sync()).toMatchObject({ kind: "updates", head: 0, taskChanges: [{ current: { version: "v_2" } }] });
    fx.persist();
    expect(await fx.sync()).toMatchObject({ kind: "caught_up" });
  });
  it.each(["stale Task", "retired Worker", "mixed pages"])("reconciles authority after %s events and converges without manual reads", async kind => {
    const fx = fixture();
    fx.tasks([{ ...task, version: "v_3", current_context: "External update" }]);
    if (kind !== "retired Worker") fx.events.push({ type: "task", ref: { taskId: task.id, version: "v_2" as any }, actor: "worker", change: "note", cursor: "1", at: "2026-10-12T00:00:00Z" });
    if (kind !== "stale Task") fx.events.push({ type: "worker", worker: "retired", membershipId: "old", phase: "prepared", cursor: String(fx.events.length + 1), at: "2026-10-12T00:00:00Z" });
    expect(await fx.service.readSyncNudgeDebt(file, ["base"])).toMatchObject({ kind: "eligible", updateCount: 1 });
    expect(await fx.service.readTeamSyncNow(file, "updates", new AbortController().signal, "auto")).toMatchObject({ kind: "updates", head: fx.events.length, taskChanges: [{ current: { version: "v_3" } }] });
    fx.persist();
    expect(await fx.service.readSyncNudgeDebt(file, fx.branch.map(entry => entry.id))).toMatchObject({ kind: "none" });
  });
  it("hydrates Workers after the snapshot watermark covers their creation", async () => {
    const fx = fixture(); fx.noWorkers();
    fx.onWatermark(() => { fx.workers([{ name: "worker", scope: "work" }]); fx.append(); });
    expect(await fx.sync("snapshot")).toMatchObject({ kind: "snapshot", head: 1, workers: [{ name: "worker" }] });
    fx.persist();
    expect(await fx.service.readTeamSyncNow(file, "updates", new AbortController().signal, "next")).toMatchObject({ kind: "quiet" });
  });
  it.each(["binding", "epoch"])("rejects %s replacement between watermark and Worker hydration", async scope => {
    const fx = fixture();
    fx.onWatermark(() => scope === "binding" ? fx.bind("new") : fx.epoch("new"));
    expect(await fx.sync("snapshot")).toMatchObject({ kind: "unavailable" });
    expect(fx.service.pending(file)).toBeUndefined();
  });
  it("presents complete Task removal as a snapshot", async () => {
    const fx = fixture(); fx.tasks([]);
    expect(await fx.sync()).toMatchObject({ kind: "snapshot", tasks: [] });
  });
  it("automatically delivers an empty removal snapshot and then clears debt", async () => {
    const fx = fixture(); fx.noWorkers(); fx.tasks([]);
    expect(await fx.service.readSyncNudgeDebt(file, ["base"])).toMatchObject({ kind: "eligible", requestedView: "snapshot", updateCount: 1 });
    expect(await fx.service.readTeamSyncNow(file, "snapshot", new AbortController().signal, "automatic")).toMatchObject({ kind: "snapshot", tasks: [] });
    fx.persist();
    expect(await fx.service.readSyncNudgeDebt(file, fx.branch.map(entry => entry.id))).toMatchObject({ kind: "none" });
  });
  it("presents partial Task removal once and converges after native persistence", async () => {
    const fx = fixture(); const second = { ...task, id: "second" };
    fx.tasks([task, second]); await fx.sync("snapshot"); fx.persist();
    fx.tasks([second]);
    expect(await fx.sync()).toMatchObject({ kind: "snapshot", tasks: [second] });
    fx.persist("removal"); expect(await fx.sync()).toMatchObject({ kind: "caught_up" });
  });
  it("ignores authority enumeration order when reconciling a native branch", async () => {
    const fx = fixture(); const second = { ...task, id: "second" };
    fx.tasks([task, second]); await fx.sync("snapshot"); fx.persist();
    fx.tasks([second, task]); expect(await fx.sync()).toMatchObject({ kind: "caught_up" });
  });
  it("returns unavailable without advancing when Task hydration fails", async () => {
    const fx = fixture(); fx.append(); fx.readTasks.mockRejectedValueOnce(new Error("offline"));
    expect(await fx.sync()).toMatchObject({ kind: "unavailable", reason: "task_authority_unavailable" });
    expect(fx.service.pending(file)).toBeUndefined();
    expect(await fx.sync()).toMatchObject({ kind: "updates", head: 1 });
  });
  it("aborts without a reservation or cursor commit", async () => {
    const fx = fixture(); const abort = new AbortController(); abort.abort();
    expect(await fx.service.readTeamSync(file, "snapshot", abort.signal, "aborted")).toMatchObject({ kind: "cancelled" });
    expect(fx.service.pending(file)).toBeUndefined();
  });
  it("derives max through from native updates and team_sync results in the authorized scope", () => {
    const branch: BranchEntry[] = [snapshotEntry("base", "team", "epoch", "lead", [], 2),
      { id: "tool", type: "message", message: { role: "toolResult", toolName: "team_sync", details: { kind: "caught_up", observation: { team: "team", epoch: "epoch", binding: "lead", from: 2, through: 7 } } } },
      snapshotEntry("late", "team", "epoch", "lead", [], 3), snapshotEntry("other", "team", "epoch", "foreign", [], 99),
      { id: "bad", type: "custom_message", customType: TEAM_UPDATE_TYPE, details: { team: "team", epoch: "epoch", binding: "lead", from: 0, through: -1 } }];
    expect(readBranchObservation(branch, { team: "team", epoch: "epoch", binding: "lead" })?.cursor).toBe("7");
  });
});
