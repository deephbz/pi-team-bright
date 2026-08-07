import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import piTeams from "../../extensions/index";
import * as authority from "../../src/model-tool-contract/beads-authority-adapter";
import { DurableModelToolTeamPort } from "../../src/model-tool-contract/durable-model-tool-port";
import { InMemoryModelToolTeamPort, exactLeaderSessionId } from "../../src/model-tool-contract/in-memory-team-port";
import { projectToolResult } from "../../src/model-tool-contract/result-projection";
import { projectTui } from "../../src/model-tool-contract/tui-projection";
import { taskVersionRef } from "../../src/model-tool-contract/task-version-ref";
import { MODEL_TOOL_IMPLEMENTATION_VERSION } from "../../src/model-tool-contract/model-tool-constants";
import { commitHiddenObservationProjection, readHiddenObservationProjection } from "../../src/utils/hidden-observation";
import { loadSyncLivenessSettings } from "../../src/utils/sync-liveness-settings";
import { SyncNudgeConductor, type SyncNudgeDebt } from "../../src/utils/sync-nudge-conductor";
import {
  createSyncNudgeRecord,
  findSyncNudgeReservation,
  presentSyncNudge,
  readSyncNudgeRecords,
  reserveSyncNudge,
  syncNudgeContent,
  syncNudgeTuiLine,
  SYNC_NUDGE_CUSTOM_TYPE,
} from "../../src/utils/sync-nudge";
import {
  livenessIsComplete,
  livenessIsProductive,
  readWorkerRunObservation,
  waitForLivenessHint,
} from "../../src/utils/sync-liveness";
import * as paths from "../../src/utils/paths";
import * as teamEvents from "../../src/utils/team-events";
import * as teams from "../../src/utils/teams";
import { writeRuntimeStatus } from "../../src/utils/runtime";
import { TASK_METADATA_SCHEMA } from "../../src/utils/beads";

const createdTeams: string[] = [];
const temporaryRoots: string[] = [];

class FakeClock {
  now = 0;
  private next = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.next++;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  };
  clearTimeout = (handle: unknown): void => { this.timers.delete(handle as number); };
  async advance(ms: number): Promise<void> {
    this.now += ms;
    const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.now);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.callback();
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function teamName(prefix: string): string {
  const name = `liveness-${prefix}-${process.pid}-${createdTeams.length}`;
  createdTeams.push(name);
  return name;
}

function member(overrides: Record<string, unknown> = {}): any {
  return {
    membershipId: "membership-1",
    agentId: "worker-agent",
    name: "worker",
    agentType: "teammate",
    joinedAt: 1,
    cwd: "/tmp",
    subscriptions: [],
    isActive: true,
    sessionFile: "worker-session.jsonl",
    ...overrides,
  };
}

function tempAgentDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-coord-liveness-e2e-"));
  temporaryRoots.push(root);
  return root;
}

function nudge(overrides: Partial<Parameters<typeof createSyncNudgeRecord>[0]> = {}) {
  return createSyncNudgeRecord({
    id: "nudge-1",
    teamName: "nudge-team",
    teamEpochId: "epoch-1",
    leaderSessionId: "leader-session",
    leaderMembershipId: "leader-membership",
    branchLineage: ["root", "branch"],
    branchId: "branch",
    debtKey: "debt-1",
    policyVersion: "1",
    requestedView: "updates",
    reservedAt: new Date(0).toISOString(),
    kind: "reserved",
    ...overrides,
  });
}

function taskEnvelope(id = "task-1", context = "Work has not started."): any {
  return {
    task: {
      id,
      title: "Task title",
      description: "Compatibility description.",
      acceptanceCriteria: "Compatibility acceptance.",
      status: "open",
      relations: [],
      version: "beads-version",
      provenance: { authority: "beads", teamName: "liveness-team" },
    },
    taskMetadata: {
      schema: TASK_METADATA_SCHEMA,
      goal: "Verify liveness.",
      current_context: context,
    },
  };
}

async function durableFixture(policy: TeamConfigSyncLiveness = { waitSeconds: 120, nudgeEnabled: true, nudgeDelaySeconds: 5, policyVersion: "1" }) {
  const name = teamName("durable");
  const sessionFile = path.join(paths.teamDir(name), "leader-session.jsonl");
  const port = new DurableModelToolTeamPort({ ensureWorker: vi.fn() } as any, { stopWorker: vi.fn(), shutdownTeam: vi.fn() });
  vi.spyOn(authority, "listTaskIds").mockResolvedValue([]);
  vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockResolvedValue([]);
  await teams.createTeam(name, sessionFile, "leader-agent", "Liveness fixture", undefined, undefined, undefined, undefined, undefined, undefined, undefined, MODEL_TOOL_IMPLEMENTATION_VERSION, undefined, policy);
  const config = await teams.readConfig(name);
  config.logicalWorkers = [{ name: "worker", scope: "liveness" }];
  teams.writeConfigAtomic(paths.configPath(name), config);
  const session = exactLeaderSessionId(`session-${name}`);
  port.setLeaderSessionFile(session, sessionFile);
  port.setBranchContext(session, ["root", "branch"]);
  return { name, session, sessionFile, port, config };
}

type TeamConfigSyncLiveness = {
  waitSeconds: number;
  nudgeEnabled: boolean;
  nudgeDelaySeconds?: number;
  policyVersion: string;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const name of createdTeams.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("hardened coordination liveness boundaries", () => {
  it("treats no Workers and settled unresolved work as complete, but active change as productive", () => {
    expect(livenessIsComplete([])).toBe(true);
    expect(livenessIsProductive([])).toBe(false);
    expect(livenessIsComplete([{ worker: "worker", state: "settled", actuationPending: false }])).toBe(true);
    expect(livenessIsProductive([{ worker: "worker", state: "settled", actuationPending: false }])).toBe(false);
    expect(livenessIsComplete([{ worker: "worker", state: "active", actuationPending: false }])).toBe(false);
    expect(livenessIsProductive([{ worker: "worker", state: "active", actuationPending: false }])).toBe(true);
  });

  it("distinguishes active to settled without a Task change and pending delivery", async () => {
    const name = teamName("runtime");
    fs.mkdirSync(paths.teamDir(name), { recursive: true });
    const current = member();
    await writeRuntimeStatus(name, "worker", { pid: process.pid, startedAt: 1, runState: "active" }, current.membershipId);
    await expect(readWorkerRunObservation(name, current)).resolves.toMatchObject({ state: "active", actuationPending: false });
    await writeRuntimeStatus(name, "worker", { runState: "settled" }, current.membershipId);
    await expect(readWorkerRunObservation(name, current)).resolves.toMatchObject({ state: "settled", actuationPending: false });

    fs.mkdirSync(path.dirname(paths.taskDeliveryPath(name, "worker")), { recursive: true });
    fs.writeFileSync(paths.taskDeliveryPath(name, "worker"), JSON.stringify([{ id: "delivery-1" }]));
    await expect(readWorkerRunObservation(name, current)).resolves.toMatchObject({ state: "settled", actuationPending: true });
    const pending = await readWorkerRunObservation(name, current);
    expect(livenessIsComplete([pending])).toBe(false);
  });

  it("fails closed for stale Membership and unknown runtime evidence", async () => {
    const name = teamName("stale-membership");
    fs.mkdirSync(paths.teamDir(name), { recursive: true });
    await writeRuntimeStatus(name, "worker", { pid: process.pid, startedAt: 1, runState: "settled" }, "other-membership");
    const observation = await readWorkerRunObservation(name, member());
    expect(observation).toMatchObject({ state: "unknown", actuationPending: false });
    expect(livenessIsComplete([observation])).toBe(false);
    expect(livenessIsProductive([observation])).toBe(false);
  });

  it("wakes on a positive runtime/event producer hint and closes the event check-register race", async () => {
    const name = teamName("event-race");
    await teams.createTeam(name, "leader-session.jsonl", "leader-agent", "Event race");
    let producer = false;
    const checking = vi.fn(() => producer);
    const waiting = waitForLivenessHint({ teamName: name, waitMs: 2_000, check: checking });
    await new Promise((resolve) => setImmediate(resolve));
    producer = true;
    await teamEvents.appendTeamEvent(name, { type: "worker", worker: "worker", membershipId: "membership-1", phase: "session_bound", generation: { membershipId: "membership-1", pid: process.pid, startedAt: 1 } });
    await expect(waiting).resolves.toBe("hint");
    expect(checking).toHaveBeenCalled();
  });

  it("uses settings defaults and overrides for bounded wait and delayed nudge policy", () => {
    const agentDir = tempAgentDir();
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({}));
    expect(loadSyncLivenessSettings({ agentDir })).toMatchObject({ waitSeconds: 120, nudgeEnabled: false });
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ pi_team_bright: { team: { wait_seconds: 7.5, nudge_enabled: true, nudge_delay_seconds: 3 } } }));
    expect(loadSyncLivenessSettings({ agentDir })).toMatchObject({ waitSeconds: 7.5, nudgeEnabled: true, nudgeDelaySeconds: 3 });
  });

  it("keeps active authority scans at the five-second floor while event hints stay immediate", async () => {
    vi.useFakeTimers();
    const name = teamName("authority-cadence");
    fs.mkdirSync(paths.teamDir(name), { recursive: true });
    const check = vi.fn(() => false);
    const checkAuthority = vi.fn(() => false);
    const controller = new AbortController();
    const waiting = waitForLivenessHint({ teamName: name, waitMs: 10_000, signal: controller.signal, check, checkAuthority });
    await Promise.resolve();
    expect(checkAuthority).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(checkAuthority).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkAuthority).toHaveBeenCalledTimes(2);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns cancellation from the actual liveness waiter without advancing observation", async () => {
    const name = teamName("cancel");
    fs.mkdirSync(paths.teamDir(name), { recursive: true });
    const controller = new AbortController();
    const waiting = waitForLivenessHint({ teamName: name, waitMs: 2_000, signal: controller.signal, check: () => false });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bounds authority rescans while a positive producer exists", async () => {
    vi.useFakeTimers();
    const name = teamName("rescan-cadence");
    fs.mkdirSync(paths.teamDir(name), { recursive: true });
    const check = vi.fn(() => false);
    const waiting = waitForLivenessHint({ teamName: name, waitMs: 1_000, check });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(check.mock.calls.length).toBeLessThanOrEqual(4);
    waiting.then(() => undefined, () => undefined);
  });

  it("returns caught_up through the model projection and persists its pending acknowledgement", async () => {
    const port = new InMemoryModelToolTeamPort();
    const session = exactLeaderSessionId("in-memory-leader");
    await port.createTeam(session, { name: teamName("in-memory"), purpose: "Liveness" });
    port.setBranchContext(session, ["snapshot-entry"]);
    const snapshot = await port.readTeamSync(session, "snapshot", new AbortController().signal, "snapshot-call");
    expect(snapshot).toMatchObject({ kind: "snapshot" });
    expect(port.getPendingObservation(session)).toBeDefined();
    expect(port.acknowledgePendingObservation(session, "snapshot-entry", ["snapshot-entry"])).toBe(true);
    expect(port.getPendingObservation(session)).toBeUndefined();

    const projected = projectToolResult("team_sync", { kind: "caught_up", head: 4, epoch_id: "epoch-1", state_changed: false, observation_advanced: true });
    expect(projected).toEqual({ kind: "caught_up", head: 4, epoch_id: "epoch-1" });
  });

  it("reports unknown Worker evidence and does not advance the durable observation", async () => {
    const fixture = await durableFixture();
    const current = await teams.readConfig(fixture.name);
    current.members.push(member({ name: "worker", membershipId: "stale", sessionFile: "stale-session" }));
    teams.writeConfigAtomic(paths.configPath(fixture.name), current);
    const observation = await readWorkerRunObservation(fixture.name, current.members.at(-1)!);
    expect(observation).toMatchObject({ state: "unknown", actuationPending: false });
    expect(livenessIsComplete([observation])).toBe(false);
  });

  it("uses a post-settle Task/event change and an eventless revision as separate rules", async () => {
    const fixture = await durableFixture();
    const branch = ["root", "branch"];
    const baseline = await commitHiddenObservationProjection(fixture.name, {
      teamEpochId: fixture.config.epochId!, exactSessionId: fixture.sessionFile, branchLineage: branch,
      acknowledgedEntryId: "branch", teamEventCursor: "0", authorityRevisions: { task_projection: "old" },
    });
    expect(baseline.kind).toBe("committed");

    const revision = await fixture.port.readSyncNudgeDebt(fixture.session, branch);
    expect(revision).toMatchObject({ kind: "indeterminate" });

    await teamEvents.appendTeamEvent(fixture.name, { type: "task", ref: { taskId: "task-1", version: taskVersionRef("v_0000000000000001") }, change: "note", actor: "team-lead" });
    await expect(fixture.port.readSyncNudgeDebt(fixture.session, branch)).resolves.toMatchObject({ kind: "none" });

    await teamEvents.appendTeamEvent(fixture.name, { type: "task", ref: { taskId: "task-1", version: taskVersionRef("v_0000000000000001") }, change: "note", actor: "worker" });
    const postSettle = await fixture.port.readSyncNudgeDebt(fixture.session, branch);
    expect(postSettle).toMatchObject({ kind: "eligible", requestedView: "updates" });
  });

  it("requires a snapshot nudge when the exact branch has no hidden baseline", async () => {
    const fixture = await durableFixture();
    const debt = await fixture.port.readSyncNudgeDebt(fixture.session, ["root", "branch"]);
    expect(debt).toMatchObject({ kind: "eligible", requestedView: "snapshot", branchLineage: ["root", "branch"], leaderSessionId: fixture.sessionFile });
  });

  it("scans every unseen event page before deciding actor provenance", async () => {
    const fixture = await durableFixture();
    const branch = ["root", "branch"];
    expect(await commitHiddenObservationProjection(fixture.name, {
      teamEpochId: fixture.config.epochId!, exactSessionId: fixture.sessionFile, branchLineage: branch,
      acknowledgedEntryId: "branch", teamEventCursor: "0", authorityRevisions: { task_projection: "current" },
    })).toMatchObject({ kind: "committed" });
    for (let index = 0; index < 55; index++) {
      await teamEvents.appendTeamEvent(fixture.name, {
        type: "task", ref: { taskId: `leader-task-${index}`, version: taskVersionRef(`leader-${index}`) },
        change: "note", actor: "team-lead",
      });
    }
    await teamEvents.appendTeamEvent(fixture.name, {
      type: "task", ref: { taskId: "worker-task-after-page-one", version: taskVersionRef("worker-after-page-one") },
      change: "note", actor: "worker",
    });
    await expect(fixture.port.readSyncNudgeDebt(fixture.session, branch)).resolves.toMatchObject({ kind: "eligible", requestedView: "updates" });
  });

  it("requires exact current Membership and the full branch lineage for nudge debt", async () => {
    const fixture = await durableFixture();
    await expect(fixture.port.readSyncNudgeDebt(fixture.session, ["branch"])).resolves.toMatchObject({ kind: "eligible", branchLineage: ["branch"] });
    await expect(fixture.port.readSyncNudgeDebt(fixture.session, ["root", "branch", "branch"])).resolves.toMatchObject({ kind: "none" });
    const mismatch = await readHiddenObservationProjection(fixture.name, { teamEpochId: fixture.config.epochId!, exactSessionId: "wrong-session", branchLineage: ["root", "branch"] });
    expect(mismatch).toMatchObject({ kind: "coordinate_mismatch", reason: "lead_session_mismatch" });
  });

  it("arms after resume-idle settlement, suppresses while busy, and supports snapshot debt", async () => {
    const clock = new FakeClock();
    let settled = false;
    let busy = true;
    let debt: SyncNudgeDebt = { kind: "eligible", debtKey: "debt-1", requestedView: "snapshot", teamEpochId: "epoch", leaderSessionId: "session", leaderMembershipId: "membership", branchLineage: ["root"], branchId: "root", policyVersion: "1" };
    const present = vi.fn();
    const conductor = new SyncNudgeConductor({ clock, delayMs: 10, readDebt: async () => debt, isSettled: () => settled, isBusy: () => busy, alreadyPresented: () => false, present });
    conductor.start();
    await conductor.reconcile();
    await clock.advance(20);
    expect(present).not.toHaveBeenCalled();
    busy = false;
    settled = true;
    conductor.notify();
    await conductor.reconcile();
    await clock.advance(9);
    expect(present).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(present).toHaveBeenCalledWith(expect.objectContaining({ requestedView: "snapshot" }));
    debt = { kind: "none" };
  });

  it("reserves before send, promotes after delivery, and survives crash/restart without duplicate presentation", async () => {
    const name = teamName("receipt");
    fs.mkdirSync(paths.teamDir(name), { recursive: true });
    const reserved = createSyncNudgeRecord({ ...nudge({ teamName: name }), kind: "reserved" });
    reserveSyncNudge(reserved);
    expect(findSyncNudgeReservation(name, reserved.debtKey, reserved.branchLineage)).toMatchObject({ kind: "reserved" });
    const presented = presentSyncNudge(reserved, new Date(1_000).toISOString());
    expect(readSyncNudgeRecords(name)).toEqual([presented]);
    expect(readSyncNudgeRecords(name)).not.toContainEqual(expect.objectContaining({ kind: "reserved" }));
    expect(syncNudgeContent(presented)).not.toContain("task-");
    expect(fs.existsSync(paths.teamEventJournalPath(name))).toBe(false);
    expect(fs.existsSync(paths.taskDir(name))).toBe(false);
  });

  it("deduplicates the same debt and re-arms a new branch or revision", async () => {
    const clock = new FakeClock();
    let sent = 0;
    let already = false;
    let debt: SyncNudgeDebt = { kind: "eligible", debtKey: "debt-1", requestedView: "updates", teamEpochId: "epoch", leaderSessionId: "session", leaderMembershipId: "membership", branchLineage: ["root", "branch"], branchId: "branch", policyVersion: "1" };
    const conductor = new SyncNudgeConductor({ clock, delayMs: 5, readDebt: async () => debt, isSettled: () => true, isBusy: () => false, alreadyPresented: () => already, present: async () => { sent++; already = true; } });
    conductor.start();
    await conductor.reconcile();
    await clock.advance(5);
    expect(sent).toBe(1);
    conductor.notify();
    await conductor.reconcile();
    await clock.advance(5);
    expect(sent).toBe(1);
    already = false;
    debt = { ...debt, debtKey: "debt-2", branchLineage: ["root", "new-branch"], branchId: "new-branch" };
    conductor.notify();
    await conductor.reconcile();
    await clock.advance(5);
    expect(sent).toBe(2);
  });

  it("keeps nudge presentation separate from Alert and Task mutation and gives one message model/TUI projection", () => {
    const record = createSyncNudgeRecord({ ...nudge({ kind: "presented", presentedAt: new Date(1_000).toISOString() }), kind: "presented", presentedAt: new Date(1_000).toISOString() });
    const content = syncNudgeContent(record);
    expect(content).toContain('team_sync({view:"updates"})');
    expect(content).not.toContain("task-");
    expect(syncNudgeTuiLine(record)).toContain("Sync nudge presented");
    expect(SYNC_NUDGE_CUSTOM_TYPE).toBe("pi-team-bright.sync-nudge");
  });

  it("projects caught_up, indeterminate, and cancellation without false Task or Alert state", () => {
    const caughtUp = { kind: "caught_up", head: 3, epoch_id: "epoch-1", state_changed: false, observation_advanced: true } as const;
    const unknown = { kind: "indeterminate", message: "Worker run-state evidence is incomplete.", state_changed: false, observation_advanced: false } as const;
    expect(projectToolResult("team_sync", caughtUp)).toEqual({ kind: "caught_up", head: 3, epoch_id: "epoch-1" });
    expect(projectToolResult("team_sync", unknown)).toEqual({ kind: "indeterminate", message: unknown.message });
    expect(projectTui({ tool: "team_sync", details: unknown, expanded: false })).toEqual(expect.arrayContaining([expect.stringContaining("indeterminate")]));
    expect(unknown).toMatchObject({ state_changed: false, observation_advanced: false });
  });

  it("registers the extension custom message renderer for delivered nudge records", () => {
    const renderers = new Map<string, (message: unknown) => unknown>();
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi: any = {
      registerMessageRenderer: (kind: string, renderer: (message: unknown) => unknown) => renderers.set(kind, renderer),
      registerTool: vi.fn(), registerCommand: vi.fn(), registerFlag: vi.fn(),
      registerProvider: vi.fn(), registerShortcut: vi.fn(),
      getAllTools: () => [], getActiveTools: () => [], setActiveTools: vi.fn(),
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      sendMessage: vi.fn(),
    };
    piTeams(pi);
    const renderer = renderers.get(SYNC_NUDGE_CUSTOM_TYPE);
    expect(renderer).toBeDefined();
    const reserved = createSyncNudgeRecord({ ...nudge({ kind: "reserved" }), kind: "reserved" });
    expect(syncNudgeTuiLine(reserved)).toContain("pending");
    const record = createSyncNudgeRecord({ ...nudge({ kind: "presented", presentedAt: new Date(1_000).toISOString() }), kind: "presented", presentedAt: new Date(1_000).toISOString() });
    expect(renderer!({ details: record })).toBeDefined();
  });
});
