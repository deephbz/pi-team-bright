import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import {
  captureTrioProjection,
  type RegisteredToolLike,
} from "../../test/support/external-harness";
import { BeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter";
import { readBeadsAuthorityFingerprint } from "./beads";
import { readHiddenObservationProjection } from "./hidden-observation";
import * as paths from "./paths";
import * as runtime from "./runtime";
import * as teams from "./teams";
import { TASK_CHANGE_ACK_ENTRY_TYPE, TASK_CHANGE_CUSTOM_TYPE } from "./task-delivery";

interface Inventory {
  schema: string;
  productionChanges: boolean;
  stages: Array<{ id: string; authority: string; evidence: string }>;
  scenarios: Array<{
    id: string;
    stages: string[];
    primaryAnchor: string;
    supportingAnchors: Array<{ path: string; proofLimit: string }>;
    result: string;
  }>;
  realRuntimeGaps: string[];
}

type Tool = {
  name: string;
  execute(callId: string, params: unknown, signal: AbortSignal, onUpdate: undefined, ctx: TestContext): Promise<any>;
};
type Handler = (event: any, ctx: TestContext) => Promise<any> | any;
type TestContext = ReturnType<typeof sessionContext>;
type Harness = ReturnType<typeof extensionHarness>;

const inventory = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), "src/utils/causal-path.inventory.json"),
  "utf8",
)) as Inventory;
const hasBd = spawnSync("bd", ["--version"], { stdio: "ignore" }).status === 0;
const createdTeams: string[] = [];
const createdRoots: string[] = [];
const startedSessions: Array<{ harness: Harness; ctx: TestContext }> = [];
let sequence = 0;

function uniqueName(suffix: string): string {
  const name = `causal-path-${suffix}-${process.pid}-${Date.now()}-${sequence++}`;
  createdTeams.push(name);
  return name;
}

function tempRoot(suffix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `causal-path-${suffix}-`));
  createdRoots.push(root);
  return root;
}

function initBeadsWorkspace(suffix: string): string {
  const workspace = path.join(tempRoot(suffix), "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks"], {
    cwd: workspace,
    stdio: "ignore",
  });
  return workspace;
}

async function fixture(suffix: string) {
  const teamName = uniqueName(suffix);
  const workspace = initBeadsWorkspace(suffix);
  const sessions = tempRoot(`${suffix}-sessions`);
  const leaderSessionFile = path.join(sessions, "leader.jsonl");
  const workerSessionFile = path.join(sessions, "worker.jsonl");
  await teams.createTeam(
    teamName,
    leaderSessionFile,
    `leader@${teamName}`,
    "Causal-path characterization fixture",
    undefined,
    undefined,
    workspace,
    `task_authority_${crypto.randomUUID()}`,
    readBeadsAuthorityFingerprint(workspace),
  );
  await teams.ensureLogicalWorker(teamName, {
    name: "worker",
    scope: "Receive and act on exact-Session Task assignments.",
  });
  await teams.addMember(teamName, {
    membershipId: teams.newMembershipId(),
    agentId: `worker@${teamName}`,
    name: "worker",
    agentType: "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile: workerSessionFile,
    cwd: process.cwd(),
    subscriptions: [],
  });
  const worker = await teams.currentMembership(teamName, "worker");
  await runtime.writeRuntimeStatus(teamName, "worker", {
    pid: process.pid,
    startedAt: Date.now(),
    runState: "active",
  }, worker.membershipId);
  return { teamName, leaderSessionFile, workerSessionFile, worker };
}

function sessionContext(sessionFile: string, entries: any[] = []) {
  const branch = [...entries];
  return {
    cwd: process.cwd(),
    mode: "tui",
    model: undefined,
    isIdle: vi.fn(() => false),
    shutdown: vi.fn(),
    sessionManager: {
      getSessionId: vi.fn(() => sessionFile),
      getSessionFile: vi.fn(() => sessionFile),
      getBranch: vi.fn(() => branch),
      buildContextEntries: vi.fn(() => branch),
      getEntries: vi.fn(() => branch),
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setFooter: vi.fn(),
      setTitle: vi.fn(),
    },
    branch,
  };
}

function extensionHarness() {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const sendMessage = vi.fn();
  const appendEntry = vi.fn();
  piTeams({
    registerTool(tool: Tool) { tools.set(tool.name, tool); },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage,
    appendEntry,
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  } as never);
  return {
    tools,
    handlers,
    sendMessage,
    appendEntry,
    async emit(event: string, payload: any, ctx: TestContext) {
      const values = [];
      for (const handler of handlers.get(event) ?? []) values.push(await handler(payload, ctx));
      return values;
    },
  };
}

function leaderHarness() {
  vi.stubEnv("PI_TEAM_NAME", "");
  vi.stubEnv("PI_AGENT_NAME", "");
  vi.stubEnv("PI_AGENT_LAUNCH_ID", "");
  vi.stubEnv("TMUX", "");
  return extensionHarness();
}

function workerHarness(teamName: string) {
  vi.stubEnv("PI_TEAM_NAME", teamName);
  vi.stubEnv("PI_AGENT_NAME", "worker");
  vi.stubEnv("PI_AGENT_LAUNCH_ID", "");
  vi.stubEnv("TMUX", "");
  return extensionHarness();
}

async function invoke(
  harness: Harness,
  toolName: string,
  callId: string,
  params: unknown,
  ctx: TestContext,
  signal = new AbortController().signal,
) {
  const tool = harness.tools.get(toolName);
  expect(tool, `missing registered public tool ${toolName}`).toBeDefined();
  await harness.emit("tool_call", { toolName }, ctx);
  return tool!.execute(callId, params, signal, undefined, ctx);
}

async function acknowledgeSync(harness: Harness, ctx: TestContext, callId: string, result: any, entryId: string) {
  ctx.branch.push({
    type: "message",
    id: entryId,
    parentId: ctx.branch.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId: callId,
      content: result.content,
      isError: false,
      timestamp: Date.now(),
    },
  });
  await harness.emit("before_provider_request", {
    payload: { persistedResult: result.content[0].text },
  }, ctx);
}

async function startWorker(harness: Harness, ctx: TestContext) {
  await harness.emit("session_start", { reason: "resume" }, ctx);
  startedSessions.push({ harness, ctx });
}

function taskMessages(harness: Harness) {
  return harness.sendMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message.customType === TASK_CHANGE_CUSTOM_TYPE);
}

function deliveryRecords(teamName: string): any[] {
  const file = paths.taskDeliveryPath(teamName, "worker");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

function deliveryTombstones(teamName: string): any[] {
  const file = paths.taskDeliveryTombstonePath(teamName, "worker");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

function restartEntries(message: any, ack: [string, any]) {
  return [
    {
      type: "custom_message",
      id: "task-presentation-entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
    },
    {
      type: "custom",
      id: "task-ack-entry",
      parentId: "task-presentation-entry",
      timestamp: new Date().toISOString(),
      customType: ack[0],
      data: ack[1],
    },
  ];
}

afterEach(async () => {
  for (const { harness, ctx } of startedSessions.splice(0).reverse()) {
    await harness.emit("session_shutdown", { reason: "quit" }, ctx).catch(() => undefined);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const teamName of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
  for (const root of createdRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("causal-path characterization inventory", () => {
  it("keeps the Task-to-observation path and its outside-in anchors machine-operable", () => {
    expect(inventory.schema).toBe("pi-teams-causal-path-characterization/1");
    expect(inventory.productionChanges).toBe(false);
    expect(inventory.stages.map((stage) => stage.id)).toEqual([
      "assigned_task",
      "exact_session_presentation",
      "successful_turn_acknowledgement",
      "leader_observation",
    ]);
    const ids = inventory.scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      "happy_path",
      "cancellation",
      "restart",
      "duplicate",
      "stale_membership",
      "delivery_failure",
      "timeout",
      "branch_safe_observation",
    ]));
    for (const scenario of inventory.scenarios) {
      expect(scenario.stages.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(process.cwd(), scenario.primaryAnchor))).toBe(true);
      for (const anchor of scenario.supportingAnchors) {
        expect(fs.existsSync(path.join(process.cwd(), anchor.path))).toBe(true);
        expect(anchor.proofLimit.length).toBeGreaterThan(0);
      }
    }
    expect(inventory.realRuntimeGaps.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasBd)("outside-in causal Task delivery through the registered extension", () => {
  it("spans public assignment, exact Session presentation, acknowledgement, leader observation, duplicate replay, and restart", async () => {
    const state = await fixture("happy");
    const lead = leaderHarness();
    const leadCtx = sessionContext(state.leaderSessionFile);
    const createInput = {
      tasks: [{
        operation_id: "assign-causal-task",
        title: "Characterize causal delivery",
        goal: "Prove assignment reaches only the exact Worker Session and remains Task authority state.",
        assignee: "worker",
      }],
    };
    const created = await invoke(lead, "task_create", "assign", createInput, leadCtx);
    const task = created.details.outcomes[0].task;
    expect(created.details).toMatchObject({
      kind: "task_create_batch",
      outcomes: [{ kind: "created", task: { status: "open", assignee: "worker" } }],
    });
    const queued = deliveryRecords(state.teamName);
    expect(queued).toEqual([expect.objectContaining({
      recipientMembershipId: state.worker.membershipId,
      recipientSessionFile: state.workerSessionFile,
      ref: { kind: "task", taskId: task.id, version: task.version },
      taskProjection: task,
      attemptCount: 0,
    })]);

    const worker = workerHarness(state.teamName);
    const workerCtx = sessionContext(state.workerSessionFile);
    await startWorker(worker, workerCtx);
    const visible = taskMessages(worker);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      display: true,
      details: {
        recipientMembershipId: state.worker.membershipId,
        deliveryIds: [queued[0].deliveryId],
      },
    });
    expect(visible[0].content).toContain("[PiTeams Task changes]");
    expect(visible[0].content).toContain("Prove assignment reaches only the exact Worker Session");
    expect(worker.sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: true, deliverAs: "steer" });

    await worker.emit("context", {
      messages: [{ role: "custom", customType: visible[0].customType, details: visible[0].details }],
    }, workerCtx);
    expect(deliveryRecords(state.teamName)[0].successfulTurnAckAt).toBeUndefined();
    await worker.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } }, workerCtx);
    expect(worker.appendEntry).toHaveBeenCalledWith(
      TASK_CHANGE_ACK_ENTRY_TYPE,
      expect.objectContaining({ deliveryIds: [queued[0].deliveryId] }),
    );
    expect(deliveryRecords(state.teamName)[0].successfulTurnAckAt).toEqual(expect.any(String));
    expect(deliveryTombstones(state.teamName)).toEqual([
      expect.objectContaining({ deliveryId: queued[0].deliveryId, evidence: "successful-turn-ack" }),
    ]);

    const current = await invoke(lead, "task_read", "read-after-ack", { task_ids: [task.id] }, leadCtx);
    expect(current.details.outcomes[0].task).toMatchObject({ id: task.id, status: "open", assignee: "worker" });

    await lead.emit("tool_call", { toolName: "task_read" }, leadCtx);
    const trio = await captureTrioProjection({
      tool: lead.tools.get("task_read") as RegisteredToolLike,
      args: { task_ids: [task.id] },
      context: leadCtx,
      toolCallId: "trio-task-read",
    });
    expect(trio.execution).toEqual({ kind: "returned", isError: false });
    expect(trio.machine?.details).toMatchObject({
      kind: "task_read_batch",
      outcomes: [{ kind: "found", task: { id: task.id, status: "open", assignee: "worker", version: task.version } }],
    });
    expect(JSON.parse(trio.model!.text)).toMatchObject({
      kind: "found",
      task: { id: task.id, status: "open", assignee: "worker", version: task.version },
    });
    for (const human of [trio.human!.collapsed, trio.human!.expanded]) {
      expect(human).toContain(JSON.stringify(task.id));
      expect(human).toContain("open");
      expect(human).toContain("@ worker");
      expect(human).toContain(task.version);
    }

    const observed = await invoke(lead, "team_sync", "observe-assignment", { view: "snapshot" }, leadCtx);
    expect(observed.details).toMatchObject({
      kind: "snapshot",
      tasks: [{ id: task.id, status: "open", assignee: "worker", version: task.version }],
    });

    const replay = await invoke(lead, "task_create", "assign-replay", createInput, leadCtx);
    expect(replay.details.outcomes[0].task).toEqual(task);
    expect(deliveryRecords(state.teamName)).toHaveLength(1);
    expect(taskMessages(worker)).toHaveLength(1);

    await worker.emit("session_shutdown", { reason: "quit" }, workerCtx);
    const startedIndex = startedSessions.findIndex((item) => item.harness === worker);
    if (startedIndex >= 0) startedSessions.splice(startedIndex, 1);
    const ack = worker.appendEntry.mock.calls[0] as [string, any];
    const restarted = workerHarness(state.teamName);
    const restartedCtx = sessionContext(state.workerSessionFile, restartEntries(visible[0], ack));
    await startWorker(restarted, restartedCtx);
    expect(taskMessages(restarted)).toHaveLength(0);
    expect(deliveryRecords(state.teamName)).toHaveLength(1);
  }, 60_000);

  it("requires an acknowledged snapshot and keeps observation position on the exact active branch", async () => {
    const state = await fixture("branch-position");
    const lead = leaderHarness();
    const leadCtx = sessionContext(state.leaderSessionFile, [{
      type: "message",
      id: "initial-user-entry",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "orient to the Team" }] },
    }]);

    const required = await invoke(lead, "team_sync", "updates-before-snapshot", { view: "updates" }, leadCtx);
    expect(required.details).toMatchObject({
      kind: "snapshot_required",
      state_changed: false,
      observation_advanced: false,
    });
    const stillRequired = await invoke(lead, "team_sync", "updates-before-snapshot-again", { view: "updates" }, leadCtx);
    expect(stillRequired.details).toEqual(required.details);

    const snapshot = await invoke(lead, "team_sync", "branch-snapshot", { view: "snapshot" }, leadCtx);
    await acknowledgeSync(lead, leadCtx, "branch-snapshot", snapshot, "branch-snapshot-entry");
    const acknowledgedSnapshotBranch = structuredClone(leadCtx.branch);

    const created = await invoke(lead, "task_create", "branch-task", {
      tasks: [{ operation_id: "branch-task", title: "Branch-visible Task", goal: "Remain visible only from an acknowledged active-branch baseline.", assignee: "worker" }],
    }, leadCtx);
    const task = created.details.outcomes[0].task;
    const updates = await invoke(lead, "team_sync", "branch-updates", { view: "updates" }, leadCtx);
    expect(updates.details).toMatchObject({
      kind: "updates",
      task_changes: [{ task_id: task.id, current: { version: task.version } }],
    });

    leadCtx.branch.splice(0, leadCtx.branch.length, {
      type: "message",
      id: "mismatched-branch-root",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "different branch" }] },
    });
    await lead.emit("before_provider_request", {
      payload: { persistedResult: updates.content[0].text },
    }, leadCtx);
    const replay = await invoke(lead, "team_sync", "branch-updates-replay", { view: "updates" }, leadCtx);
    expect(replay.details).toEqual(updates.details);
    expect(replay.content).toEqual(updates.content);

    leadCtx.branch.splice(0, leadCtx.branch.length, ...acknowledgedSnapshotBranch);
    await acknowledgeSync(lead, leadCtx, "branch-updates", updates, "branch-updates-entry");
    leadCtx.branch.splice(0, leadCtx.branch.length, {
      type: "message",
      id: "fork-lineage-root",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "fork lineage" }] },
    });
    const mismatched = await invoke(lead, "team_sync", "mismatched-lineage", { view: "updates" }, leadCtx);
    expect(mismatched.details).toMatchObject({
      kind: "snapshot_required",
      state_changed: false,
      observation_advanced: false,
    });
  }, 60_000);

  it("characterizes public team_sync timeout and cancellation without losing later authority changes", async () => {
    const state = await fixture("wait");
    const lead = leaderHarness();
    const leadCtx = sessionContext(state.leaderSessionFile);
    const baseline = await invoke(lead, "team_sync", "baseline", { view: "snapshot" }, leadCtx);
    await acknowledgeSync(lead, leadCtx, "baseline", baseline, "baseline-entry");

    const realSetTimeout = globalThis.setTimeout;
    let releaseDeadline: (() => void) | undefined;
    let signalScheduled!: (delay: number) => void;
    const deadlineScheduled = new Promise<number>((resolve) => { signalScheduled = resolve; });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      if (delay === 120_000) {
        releaseDeadline = () => callback(...args);
        signalScheduled(delay);
        return { unref() { return this; } } as unknown as NodeJS.Timeout;
      }
      return realSetTimeout(callback, delay ?? 0, ...args);
    }) as typeof setTimeout);
    let waitSettled = false;
    const waitResult = invoke(lead, "team_sync", "timed-out", { view: "updates" }, leadCtx)
      .then((result) => {
        waitSettled = true;
        return result;
      });
    let guard: ReturnType<typeof setTimeout> | undefined;
    const scheduledDelay = await Promise.race([
      deadlineScheduled,
      waitResult.then((result) => { throw new Error(`team_sync settled before it scheduled its deadline: ${JSON.stringify(result.details)}`); }),
      new Promise<never>((_resolve, reject) => {
        guard = realSetTimeout(() => reject(new Error("team_sync did not schedule its deadline within 20 seconds")), 20_000);
      }),
    ]).finally(() => {
      if (guard) clearTimeout(guard);
    });
    expect(scheduledDelay).toBe(120_000);
    expect(releaseDeadline).toBeDefined();
    await Promise.resolve();
    expect(waitSettled).toBe(false);

    releaseDeadline!();
    const timedOut = await waitResult;
    expect(waitSettled).toBe(true);
    expect(timedOut.details).toEqual({
      kind: "indeterminate",
      message: "Worker run-state evidence is incomplete after the bounded wait; no observation was published.",
      state_changed: false,
      observation_advanced: false,
    });
    timeoutSpy.mockRestore();

    const controller = new AbortController();
    const pending = invoke(lead, "team_sync", "cancelled", { view: "updates" }, leadCtx, controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      details: { kind: "cancelled", state_changed: false, observation_advanced: false },
    });

    const created = await invoke(lead, "task_create", "after-cancel", {
      tasks: [{ operation_id: "after-cancel", title: "Visible after cancel", goal: "Remain observable after cancellation.", assignee: "worker" }],
    }, leadCtx);
    const task = created.details.outcomes[0].task;
    const afterCancel = await invoke(lead, "team_sync", "after-cancel-sync", { view: "updates" }, leadCtx);
    expect(afterCancel.details).toMatchObject({
      kind: "updates",
      task_changes: [{ task_id: task.id, current: { version: task.version } }],
    });
  }, 60_000);

  it("refuses stale Membership presentation and reconstructs delivery for the replacement exact Session", async () => {
    const state = await fixture("stale");
    const lead = leaderHarness();
    const leadCtx = sessionContext(state.leaderSessionFile);
    const created = await invoke(lead, "task_create", "assign-stale", {
      tasks: [{ operation_id: "assign-stale", title: "Replace binding", goal: "Deliver only to the replacement exact Session.", assignee: "worker" }],
    }, leadCtx);
    const task = created.details.outcomes[0].task;
    const staleRecord = deliveryRecords(state.teamName)[0];

    await teams.deactivateMembership(state.teamName, state.worker.membershipId!, "replaced");
    const replacementSessionFile = path.join(path.dirname(state.workerSessionFile), "replacement.jsonl");
    const replacementMembershipId = teams.newMembershipId();
    await teams.addMember(state.teamName, {
      membershipId: replacementMembershipId,
      agentId: `replacement@${state.teamName}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile: replacementSessionFile,
      cwd: process.cwd(),
      subscriptions: [],
    });
    await runtime.writeRuntimeStatus(state.teamName, "worker", {
      pid: process.pid,
      startedAt: Date.now(),
    }, replacementMembershipId);

    const stale = workerHarness(state.teamName);
    const staleCtx = sessionContext(state.workerSessionFile);
    await startWorker(stale, staleCtx);
    expect(taskMessages(stale)).toHaveLength(0);
    expect(staleCtx.shutdown).toHaveBeenCalledOnce();

    const replacement = workerHarness(state.teamName);
    const replacementCtx = sessionContext(replacementSessionFile);
    await startWorker(replacement, replacementCtx);
    expect(taskMessages(replacement)).toEqual([expect.objectContaining({
      details: expect.objectContaining({
        recipientMembershipId: replacementMembershipId,
        changes: [{ ref: { kind: "task", taskId: task.id, version: task.version }, changeKind: "task_changed" }],
      }),
    })]);
    expect(deliveryRecords(state.teamName)).toEqual(expect.arrayContaining([
      expect.objectContaining({ deliveryId: staleRecord.deliveryId, recipientMembershipId: state.worker.membershipId }),
      expect.objectContaining({ recipientMembershipId: replacementMembershipId, recipientSessionFile: replacementSessionFile }),
    ]));
  }, 60_000);

  it("keeps an unavailable event hydration unacknowledged, then retries through the registered raw, model, and TUI boundary", async () => {
    const state = await fixture("unavailable-retry");
    const lead = leaderHarness();
    const leadCtx = sessionContext(state.leaderSessionFile);
    const snapshot = await invoke(lead, "team_sync", "unavailable-baseline", { view: "snapshot" }, leadCtx);
    await acknowledgeSync(lead, leadCtx, "unavailable-baseline", snapshot, "unavailable-baseline-entry");

    const created = await invoke(lead, "task_create", "unavailable-create", {
      tasks: [{
        operation_id: "unavailable-create",
        title: "Retry unavailable hydration",
        goal: "Keep the acknowledgement boundary behind complete Task authority evidence.",
        assignee: "worker",
      }],
    }, leadCtx);
    const task = created.details.outcomes[0].task;
    const hydrate = vi.spyOn(BeadsTaskAdapter.prototype, "readMany")
      .mockRejectedValueOnce(new Error("injected Task authority outage"));

    await lead.emit("tool_call", { toolName: "team_sync" }, leadCtx);
    const unavailable = await captureTrioProjection({
      tool: lead.tools.get("team_sync") as RegisteredToolLike,
      args: { view: "updates" },
      context: leadCtx,
      toolCallId: "unavailable-update",
    });
    const raw = {
      kind: "unavailable",
      reason: "task_authority_unavailable",
      message: "injected Task authority outage",
      state_changed: false,
      observation_advanced: false,
    };
    expect(unavailable.execution).toEqual({ kind: "returned", isError: false });
    expect(unavailable.machine).toEqual({ details: raw, json: JSON.stringify(raw) });
    expect(unavailable.model?.text).toBe(JSON.stringify({
      kind: "unavailable",
      reason: "task_authority_unavailable",
      message: "injected Task authority outage",
    }));
    const compactTui = (value: string | undefined) => value?.split("\n").map((line) => line.trimEnd()).join("\n");
    expect(compactTui(unavailable.human?.collapsed)).toBe(
      "! unavailable\n  unavailable · task_authority_unavailable: injected Task authority outage",
    );
    expect(compactTui(unavailable.human?.expanded)).toBe(
      "! unavailable\n  unavailable · task_authority_unavailable: injected Task authority outage",
    );

    const config = await teams.readConfig(state.teamName);
    const beforeRetry = await readHiddenObservationProjection(state.teamName, {
      teamEpochId: config.epochId!,
      exactSessionId: state.leaderSessionFile,
      branchLineage: ["unavailable-baseline-entry"],
    });
    expect(beforeRetry).toMatchObject({
      kind: "found",
      projection: {
        teamEventCursor: "0",
        authorityRevisions: expect.objectContaining({ team_events: "0", task_event_failure_hints: "0" }),
      },
    });

    const retried = await invoke(lead, "team_sync", "unavailable-retry", { view: "updates" }, leadCtx);
    expect(retried.details).toMatchObject({
      kind: "updates",
      task_changes: [{ task_id: task.id, current: { id: task.id, version: task.version } }],
    });
    const staged = await readHiddenObservationProjection(state.teamName, {
      teamEpochId: config.epochId!,
      exactSessionId: state.leaderSessionFile,
      branchLineage: ["unavailable-baseline-entry"],
    });
    expect(staged).toMatchObject({
      kind: "found",
      projection: { teamEventCursor: "0", authorityRevisions: expect.objectContaining({ task_event_failure_hints: "0" }) },
    });

    await acknowledgeSync(lead, leadCtx, "unavailable-retry", retried, "unavailable-retry-entry");
    const acknowledged = await readHiddenObservationProjection(state.teamName, {
      teamEpochId: config.epochId!,
      exactSessionId: state.leaderSessionFile,
      branchLineage: ["unavailable-baseline-entry", "unavailable-retry-entry"],
    });
    expect(acknowledged).toMatchObject({
      kind: "found",
      projection: {
        teamEventCursor: "1",
        authorityRevisions: expect.objectContaining({ team_events: "1", task_event_failure_hints: "0" }),
      },
    });
    const delivered = deliveryRecords(state.teamName).map((record) => ({
      ...record,
      successfulTurnAckAt: new Date().toISOString(),
    }));
    fs.writeFileSync(paths.taskDeliveryPath(state.teamName, "worker"), JSON.stringify(delivered));
    await runtime.writeRuntimeStatus(state.teamName, "worker", {
      pid: process.pid,
      startedAt: Date.now(),
      runState: "settled",
    }, state.worker.membershipId);
    await expect(invoke(lead, "team_sync", "unavailable-caught-up", { view: "updates" }, leadCtx))
      .resolves.toMatchObject({ details: { kind: "caught_up", observation_advanced: true } });
  }, 60_000);

  it("performs one quiet-authority read before 5 seconds, then cadence and post-wake reads before acknowledgement", async () => {
    const state = await fixture("quiet-cadence");
    const lead = leaderHarness();
    const leadCtx = sessionContext(state.leaderSessionFile);
    const created = await invoke(lead, "task_create", "quiet-create", {
      tasks: [{
        operation_id: "quiet-create",
        title: "Quiet authority revision",
        goal: "Make a Task revision visible after the bounded quiet-authority cadence.",
        assignee: "worker",
      }],
    }, leadCtx);
    const task = created.details.outcomes[0].task;
    const baseline = await invoke(lead, "team_sync", "quiet-baseline", { view: "snapshot" }, leadCtx);
    await acknowledgeSync(lead, leadCtx, "quiet-baseline", baseline, "quiet-baseline-entry");
    fs.writeFileSync(paths.taskDeliveryPath(state.teamName, "worker"), JSON.stringify(deliveryRecords(state.teamName).map((record) => ({
      ...record,
      successfulTurnAckAt: new Date().toISOString(),
    }))));
    await runtime.writeRuntimeStatus(state.teamName, "worker", {
      pid: process.pid,
      startedAt: Date.now(),
      runState: "active",
    }, state.worker.membershipId);

    // The cadence clock uses fake timers. Keep its authority fixture in-memory,
    // because a real `bd` child process cannot make progress while timer
    // advancement waits for this async cadence callback on Linux.
    let completeReads = 0;
    let releaseInitialRead!: () => void;
    let releaseInitialResult!: () => void;
    const initialRead = new Promise<void>((resolve) => { releaseInitialRead = resolve; });
    const initialResult = new Promise<void>((resolve) => { releaseInitialResult = resolve; });
    const changedVersion = "v_1111111111111111";
    vi.spyOn(BeadsTaskAdapter.prototype, "listIds").mockResolvedValue([task.id]);
    const readMany = vi.spyOn(BeadsTaskAdapter.prototype, "readMany").mockImplementation(async (taskIds) => {
      completeReads++;
      if (completeReads === 1) {
        releaseInitialRead();
        await initialResult;
      }
      return taskIds.map((taskId) => taskId === task.id
        ? { kind: "found" as const, task: { ...task, version: completeReads < 2 ? task.version : changedVersion } }
        : undefined);
    });
    vi.useFakeTimers();
    const controller = new AbortController();
    const update = invoke(lead, "team_sync", "quiet-update", { view: "updates" }, leadCtx, controller.signal);
    try {
      await initialRead;
      expect(readMany).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(readMany).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      releaseInitialResult();
      await expect(update).resolves.toMatchObject({
        details: {
          kind: "updates",
          task_changes: [{ task_id: task.id, change_kinds: ["progress"], current: { version: changedVersion } }],
        },
      });
      // The cadence detects the revision, then the public sync path performs its
      // complete post-wake read before it can stage the returned projection.
      // This measured duplicate is a later performance candidate, not a second
      // authority or acknowledgement advance.
      expect(readMany).toHaveBeenCalledTimes(3);

      const config = await teams.readConfig(state.teamName);
      const staged = await readHiddenObservationProjection(state.teamName, {
        teamEpochId: config.epochId!,
        exactSessionId: state.leaderSessionFile,
        branchLineage: ["quiet-baseline-entry"],
      });
      expect(staged).toMatchObject({
        kind: "found",
        projection: {
          teamEventCursor: "1",
          authorityRevisions: expect.objectContaining({ task_projection: expect.any(String), task_event_failure_hints: "0" }),
        },
      });
      await acknowledgeSync(lead, leadCtx, "quiet-update", await update, "quiet-update-entry");
      await runtime.writeRuntimeStatus(state.teamName, "worker", {
        pid: process.pid,
        startedAt: Date.now(),
        runState: "settled",
      }, state.worker.membershipId);
      await expect(invoke(lead, "team_sync", "quiet-caught-up", { view: "updates" }, leadCtx))
        .resolves.toMatchObject({ details: { kind: "caught_up", observation_advanced: true } });
    } finally {
      controller.abort();
      await update.catch(() => undefined);
      vi.useRealTimers();
    }
  }, 60_000);

  it("reports degraded public assignment and recovers after atomic delivery-spool failure", async () => {
    const state = await fixture("failure");
    const lead = leaderHarness();
    const leadCtx = sessionContext(state.leaderSessionFile);
    const spool = paths.taskDeliveryPath(state.teamName, "worker");
    const originalRename = fs.renameSync;
    let injected = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (!injected && String(target) === spool) {
        injected = true;
        throw new Error("injected spool publication failure");
      }
      return originalRename(source, target);
    });

    const created = await invoke(lead, "task_create", "degraded", {
      tasks: [{ operation_id: "degraded", title: "Recover publication", goal: "Remain committed when delivery publication fails.", assignee: "worker" }],
    }, leadCtx);
    const outcome = created.details.outcomes[0];
    expect(injected).toBe(true);
    expect(outcome).toMatchObject({
      kind: "created",
      task: { status: "open", assignee: "worker" },
      delivery_warnings: [expect.stringContaining("delivery enqueue for worker failed")],
    });
    expect(deliveryRecords(state.teamName)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(paths.taskDeliveryRecoveryPath(state.teamName), "utf8"))).toEqual([
      expect.objectContaining({
        taskId: outcome.task.id,
        taskVersion: outcome.task.version,
        recipients: ["worker"],
        reason: "enqueue-failed",
        taskProjection: outcome.task,
      }),
    ]);

    vi.restoreAllMocks();
    const worker = workerHarness(state.teamName);
    const workerCtx = sessionContext(state.workerSessionFile);
    await startWorker(worker, workerCtx);
    expect(taskMessages(worker)).toEqual([expect.objectContaining({
      display: true,
      details: expect.objectContaining({
        recipientMembershipId: state.worker.membershipId,
        changes: [{ ref: { kind: "task", taskId: outcome.task.id, version: outcome.task.version }, changeKind: "task_changed" }],
      }),
    })]);
    expect(deliveryRecords(state.teamName)).toHaveLength(1);
  }, 60_000);
});
