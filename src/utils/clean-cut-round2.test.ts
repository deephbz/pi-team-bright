import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { writeJsonAtomic } from "./atomic-json";
import { BeadsTaskStore, TASK_METADATA_KEY, TASK_METADATA_SCHEMA, readBeadsAuthorityFingerprint } from "./beads";
import { projectTaskCard } from "../model-tool-contract/beads-task-adapter";
import { BeadsTaskReconciliationQuery } from "../task-authority/beads-reconciliation-query";
import type { BdRunner } from "./beads";
import type { Member, TeamConfig } from "./models";
import type { TaskCard } from "../model-tool-contract/task-domain";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import * as messaging from "./messaging";
import * as paths from "./paths";
import {
  TASK_CHANGE_CUSTOM_TYPE,
  TaskChangeDelivery,
  enqueueTaskChange,
  enqueueTaskChangeForRecipient,
  recordTaskDeliveryRecovery,
  readTaskDeliveries,
  reconcileTaskChanges,
} from "./task-delivery";
import { applySemanticTaskUpdate as applyRawSemanticTaskUpdate } from "../model-tool-contract/beads-authority-adapter";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { createTaskAuthorityTeamPort } from "../../test/support/task-authority-team-port";
import * as tasks from "./tasks";
import * as teams from "./teams";
type RegisteredTool = {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (toolCallId: string, params: any, signal?: unknown, onUpdate?: unknown, ctx?: any) => Promise<any>;
};

const hasBd = spawnSync("bd", ["--version"], { stdio: "ignore" }).status === 0;
const createdTeams: string[] = [];
const roots: string[] = [];
const publicationPort = new DurableTaskMutationPublication();
const taskAuthorityTeamPort = createTaskAuthorityTeamPort();
type SemanticUpdateArgs = Parameters<typeof applyRawSemanticTaskUpdate>;
const applySemanticTaskUpdate = (...args: [SemanticUpdateArgs[0], SemanticUpdateArgs[1], SemanticUpdateArgs[2], SemanticUpdateArgs[3]]) =>
  applyRawSemanticTaskUpdate(...args, publicationPort, taskAuthorityTeamPort);

function uniqueTeam(suffix: string): string {
  const name = `clean-cut-r2-${suffix}-${process.pid}-${Date.now()}-${createdTeams.length}`;
  createdTeams.push(name);
  return name;
}

function tempRoot(suffix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-teams-r2-${suffix}-`));
  roots.push(root);
  return root;
}

function initWorkspace(): string {
  const workspace = path.join(tempRoot("beads"), "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks"], {
    cwd: workspace,
    stdio: "ignore",
  });
  return workspace;
}

function member(teamName: string, name: string, sessionFile: string): Member {
  return {
    membershipId: `membership_${name}_${crypto.randomUUID()}`,
    agentId: `${name}@${teamName}`,
    name,
    agentType: name === "team-lead" ? "lead" : "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile,
    cwd: process.cwd(),
    subscriptions: [],
  };
}

function writeTeam(
  teamName: string,
  workspace: string,
  members: Member[],
): TeamConfig {
  fs.mkdirSync(paths.teamDir(teamName), { recursive: true });
  const config: TeamConfig = {
    name: teamName,
    description: "round-2 evaluator fixture",
    epochId: teams.newTeamEpochId(),
    createdAt: Date.now(),
    leadAgentId: "lead-agent",
    leadSessionId: "lead-session",
    members,
    logicalWorkers: members.filter((candidate) => candidate.name !== "team-lead").map((candidate) => ({ name: candidate.name, scope: "round-2 worker capability" })),
    taskBackend: "beads",
    taskWorkspace: workspace,
    taskAuthorityId: `task_authority_${crypto.randomUUID()}`,
    taskAuthorityFingerprint: fs.existsSync(path.join(workspace, ".beads", "metadata.json"))
      ? readBeadsAuthorityFingerprint(workspace)
      : { schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: `test_${teamName}`, projectId: `test-${teamName}` },
  };
  teams.writeConfigAtomic(paths.configPath(teamName), config);
  return config;
}

function harness() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const sendMessage = vi.fn();
  piTeams({
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
    on(event: string, handler: (event: any, ctx: any) => Promise<any>) { handlers.set(event, handler); },
    sendMessage,
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
  } as never);
  return { tools, handlers, sendMessage };
}

function taskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: overrides.id || "task-1",
    title: overrides.title || "Task",
    goal: "Deliver the canonical Task card.",
    current_context: "The Task is ready for delivery.",
    status: overrides.status || "in_progress",
    ...(overrides.assignee ? { assignee: overrides.assignee } : {}),
    version: overrides.version || taskVersionRef("v1"),
  };
}

function createTask(store: BeadsTaskStore, title: string, description: string) {
  return store.create({
    title,
    description,
    internalMetadata: {
      [TASK_METADATA_KEY]: {
        schema: TASK_METADATA_SCHEMA,
        goal: description,
        current_context: "The Task is ready for canonical delivery.",
      },
    },
  });
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const teamName of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasBd)("reconciliation identity and ownership delivery", () => {
  it("suppresses a self-authored exact post-state only for the exact actor Session", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("self-suppression");
    const sourceSession = `/tmp/${teamName}-source.jsonl`;
    const sameNameOtherSession = `/tmp/${teamName}-other.jsonl`;
    writeTeam(teamName, workspace, [
      member(teamName, "team-lead", `/tmp/${teamName}-lead.jsonl`),
      member(teamName, "worker", sourceSession),
    ]);
    const store = new BeadsTaskStore({ teamName, workspace, actor: "worker", requireExpectedVersion: false });
    const reconciliationQuery = new BeadsTaskReconciliationQuery(teamName);
    const created = await createTask(store, "self assignment", "same name is not identity");

    const selfAssigned = (await applySemanticTaskUpdate(teamName, created.id, {
      assignee: "worker",
      status: "in_progress",
    }, {
      actor: "worker",
      actingSessionFile: sourceSession,
      expectedVersion: created.version,
      taskMetadata: { schema: TASK_METADATA_SCHEMA, goal: "same name is not identity", current_context: "The Task is ready for canonical delivery." },
      taskCardProjector: projectTaskCard,
    })).task;
    expect(selfAssigned.assignee).toBe("worker");
    expect(await readTaskDeliveries(teamName, "worker")).toEqual([]);
    expect(await reconcileTaskChanges(teamName, "worker", reconciliationQuery)).toBe(0);
    expect(await readTaskDeliveries(teamName, "worker")).toEqual([]);

    // A fork/new Session with the same display name is a different Agent.
    await teams.updateMember(teamName, "worker", { sessionFile: sameNameOtherSession });
    expect(await reconcileTaskChanges(teamName, "worker", reconciliationQuery)).toBe(1);
    expect(await readTaskDeliveries(teamName, "worker")).toEqual([
      expect.objectContaining({
        recipientSessionFile: sameNameOtherSession,
        changeKind: "task_changed",
        ref: expect.objectContaining({ kind: "task", taskId: created.id, version: taskVersionRef(selfAssigned.version) }),
      }),
    ]);
  }, 60_000);

  it("does not let a self-authored marker suppress a later externally changed post-state", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("post-state");
    const sessionFile = `/tmp/${teamName}-worker.jsonl`;
    writeTeam(teamName, workspace, [
      member(teamName, "team-lead", `/tmp/${teamName}-lead.jsonl`),
      member(teamName, "worker", sessionFile),
    ]);
    const store = new BeadsTaskStore({ teamName, workspace, actor: "worker", requireExpectedVersion: false });
    const reconciliationQuery = new BeadsTaskReconciliationQuery(teamName);
    const created = await createTask(store, "post-state", "v0");
    const selfAssigned = (await applySemanticTaskUpdate(teamName, created.id, { assignee: "worker" }, {
      actor: "worker",
      actingSessionFile: sessionFile,
      expectedVersion: created.version,
      taskMetadata: { schema: TASK_METADATA_SCHEMA, goal: "v0", current_context: "The Task is ready for canonical delivery." },
      taskCardProjector: projectTaskCard,
    })).task;
    expect(await reconcileTaskChanges(teamName, "worker", reconciliationQuery)).toBe(0);

    const changed = await store.update(created.id, { description: "external v2" }, {
      actor: "team-lead",
      expectedVersion: selfAssigned.version,
    });
    expect(changed.version).toBeDefined();
    expect(await reconcileTaskChanges(teamName, "worker", reconciliationQuery)).toBe(1);
    expect(await readTaskDeliveries(teamName, "worker")).toEqual([
      expect.objectContaining({
        changeKind: "task_changed",
        ref: expect.objectContaining({ kind: "task", taskId: changed.id, version: taskVersionRef(changed.version) }),
        taskProjection: expect.objectContaining({ id: changed.id, status: changed.status, goal: "v0" }),
      }),
    ]);
  }, 60_000);

  it("notifies the prior assignee on reassignment/unassignment and the new assignee on assignment", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("ownership");
    writeTeam(teamName, workspace, [
      member(teamName, "team-lead", `/tmp/${teamName}-lead.jsonl`),
      member(teamName, "alice", `/tmp/${teamName}-alice.jsonl`),
      member(teamName, "bob", `/tmp/${teamName}-bob.jsonl`),
    ]);
    const store = new BeadsTaskStore({ teamName, workspace, actor: "team-lead", requireExpectedVersion: false });
    const created = await createTask(store, "ownership", "handoff");
    const alice = (await applySemanticTaskUpdate(teamName, created.id, { assignee: "alice" }, {
      actor: "team-lead",
      actingSessionFile: `/tmp/${teamName}-lead.jsonl`,
      expectedVersion: created.version,
      taskMetadata: { schema: TASK_METADATA_SCHEMA, goal: "handoff", current_context: "The Task is ready for canonical delivery." },
      taskCardProjector: projectTaskCard,
    })).task;
    const bob = (await applySemanticTaskUpdate(teamName, created.id, { assignee: "bob" }, {
      actor: "team-lead",
      actingSessionFile: `/tmp/${teamName}-lead.jsonl`,
      expectedVersion: alice.version,
      taskMetadata: { schema: TASK_METADATA_SCHEMA, goal: "handoff", current_context: "The Task is ready for canonical delivery." },
      taskCardProjector: projectTaskCard,
    })).task;

    expect(await readTaskDeliveries(teamName, "alice")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        changeKind: "ownership_lost",
        taskProjection: expect.objectContaining({ id: bob.id, assignee: "bob" }),
        ref: expect.objectContaining({ kind: "task", taskId: bob.id, version: taskVersionRef(bob.version) }),
      }),
    ]));
    expect(await readTaskDeliveries(teamName, "bob")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        changeKind: "assigned",
        taskProjection: expect.objectContaining({ id: bob.id, assignee: "bob" }),
      }),
    ]));

    const unassigned = (await applySemanticTaskUpdate(teamName, created.id, { assignee: "" }, {
      actor: "team-lead",
      actingSessionFile: `/tmp/${teamName}-lead.jsonl`,
      expectedVersion: bob.version,
      taskMetadata: { schema: TASK_METADATA_SCHEMA, goal: "handoff", current_context: "The Task is ready for canonical delivery." },
      taskCardProjector: projectTaskCard,
    })).task;
    const bobDeliveries = await readTaskDeliveries(teamName, "bob");
    const ownershipLost = bobDeliveries.find((delivery) =>
      delivery.changeKind === "ownership_lost" && delivery.ref.version === taskVersionRef(unassigned.version));
    expect(ownershipLost).toBeDefined();
    expect(ownershipLost?.taskProjection?.assignee).toBeUndefined();
  }, 60_000);
});

describe("delivery scheduling and exact Session scope", () => {
  it("reconciles once at startup but never polls Beads periodically", async () => {
    vi.useFakeTimers();
    const workspace = tempRoot("declared-workspace");
    const teamName = uniqueTeam("no-periodic-bd");
    const sessionFile = `/tmp/${teamName}.jsonl`;
    writeTeam(teamName, workspace, [member(teamName, "worker", sessionFile)]);
    const reconcile = vi.fn(async () => 0);
    const delivery = new TaskChangeDelivery({ sendMessage: vi.fn(), appendEntry: vi.fn() }, {
      teamName,
      recipient: "worker",
      sessionFile,
      pollMs: 50,
      reconcile,
    });

    await delivery.start([]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    delivery.stop();
  });

  it("delivers only to the exact bound Session and never to a fork with copied history", async () => {
    const workspace = tempRoot("declared-workspace");
    const teamName = uniqueTeam("exact-session");
    const sourceSession = `/tmp/${teamName}-source.jsonl`;
    const forkSession = `/tmp/${teamName}-fork.jsonl`;
    writeTeam(teamName, workspace, [member(teamName, "worker", sourceSession)]);
    const record = await enqueueTaskChange(teamName, taskCard({ assignee: "worker" }), "assigned", "team-lead");
    expect(record).not.toBeNull();

    const sourceSend = vi.fn();
    const source = new TaskChangeDelivery({ sendMessage: sourceSend, appendEntry: vi.fn() }, {
      teamName,
      recipient: "worker",
      sessionFile: sourceSession,
      reconcile: async () => 0,
    });
    await source.start([]);
    expect(sourceSend).toHaveBeenCalledTimes(1);
    const sourceCustom = {
      type: "custom_message",
      id: "source-custom",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: TASK_CHANGE_CUSTOM_TYPE,
      content: sourceSend.mock.calls[0][0].content,
      display: true,
      details: sourceSend.mock.calls[0][0].details,
    } as any;
    source.stop();

    const forkSend = vi.fn();
    const fork = new TaskChangeDelivery({ sendMessage: forkSend, appendEntry: vi.fn() }, {
      teamName,
      recipient: "worker",
      sessionFile: forkSession,
      reconcile: async () => 0,
    });
    await fork.start([sourceCustom]);
    expect(forkSend).not.toHaveBeenCalled();
    expect((await readTaskDeliveries(teamName, "worker"))[0].recipientSessionFile).toBe(sourceSession);
    fork.stop();
  });
});

describe.skipIf(!hasBd)("semantic task_update surface", () => {
  it("preserves task_create post-commit delivery warnings in backend and public receipts", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("create-delivery-warning");
    const leadSession = `/tmp/${teamName}-lead.jsonl`;
    writeTeam(teamName, workspace, [
      member(teamName, "team-lead", leadSession),
      member(teamName, "worker", `/tmp/${teamName}-worker.jsonl`),
    ]);
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // A directory at the recipient spool path deterministically fails the
    // post-commit enqueue while leaving Beads Task authority writable.
    fs.mkdirSync(paths.taskDeliveryPath(teamName, "worker"), { recursive: true });
    const result = await harness().tools.get("task_create")!.execute("create-degraded", {
      tasks: [{
        operation_id: "create-delivery-degradation",
        title: "Preserve delivery degradation",
        goal: "The Task commit must survive delivery degradation and remain readable.",
        assignee: "worker",
      }],
    }, undefined, undefined, {
      sessionManager: { getSessionFile: () => leadSession },
    });

    const task = result.details.outcomes[0].task;
    expect(result.details).toMatchObject({
      kind: "task_create_batch",
      outcomes: [{ kind: "created", input_index: 0, task: { id: task.id, title: "Preserve delivery degradation", status: "open", assignee: "worker", version: task.version } }],
    });
    await expect(tasks.readTask(teamName, task.id)).resolves.toMatchObject({
      id: task.id,
      title: "Preserve delivery degradation",
      assignee: "worker",
      version: task.version,
    });
  }, 60_000);

  it("returns concise model-visible post-state and version for every Task mutation tool", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("mutation-receipts");
    const leadSession = `/tmp/${teamName}-lead.jsonl`;
    writeTeam(teamName, workspace, [
      member(teamName, "team-lead", leadSession),
      member(teamName, "worker", `/tmp/${teamName}-worker.jsonl`),
    ]);
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const tools = harness().tools;
    const context = { sessionManager: { getSessionFile: () => leadSession } };

    const createdResult = await tools.get("task_create")!.execute("create", {
      tasks: [{ operation_id: "create-receipt-contract", title: "Receipt contract", goal: "Keep the mutation receipt concise and verifiable." }],
    }, undefined, undefined, context);
    const created = createdResult.details.outcomes[0].task;
    expect(createdResult.details).toMatchObject({
      kind: "task_create_batch",
      outcomes: [{ kind: "created", input_index: 0, task: { id: expect.any(String), status: "open", version: expect.stringMatching(/^v_[0-9a-f]{16}$/) } }],
    });

    const update = async (operationId: string, expectedVersion: string, status: "open" | "in_progress", text: string) => {
      const result = await tools.get("task_update")!.execute(operationId, {
        updates: [{ task_id: created.id, operation_id: operationId, expected_version: expectedVersion, status, current_context: text, journal_entries: [{ kind: "progress", text }] }],
      }, undefined, undefined, context);
      expect(result.details).toMatchObject({ kind: "task_update_batch", outcomes: [{ kind: "updated", task_id: created.id, operation_id: operationId, task: { id: created.id, status }, journal_entries: [expect.objectContaining({ text })] }] });
      return result.details.outcomes[0].task;
    };
    const designed = await update("design", created.version, "open", "Inspect then test.");
    const evaluated = await update("approve", designed.version, "in_progress", "Leader approved execution.");
    const progressed = await update("progress", evaluated.version, "in_progress", "Comment-backed revision.");

    const syncResult = await tools.get("team_sync")!.execute("sync", { view: "snapshot" }, undefined, undefined, context);
    expect(syncResult.details).toMatchObject({ kind: "snapshot", tasks: [expect.objectContaining({ id: created.id, version: progressed.version })] });
    const readResult = await tools.get("task_read")!.execute("read", { task_ids: [created.id] }, undefined, undefined, context);
    expect(readResult.details).toMatchObject({ kind: "task_read_batch", outcomes: [{ kind: "found", task_id: created.id, task: { status: "in_progress", version: progressed.version } }] });
    await expect(update("safe-next-write", progressed.version, "open", "Safe next write.")).resolves.toMatchObject({ version: expect.any(String) });
  }, 60_000);

  it("combines assignee plus nonterminal status in one native update and returns full post-state plus applied operations", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("semantic-update");
    writeTeam(teamName, workspace, [
      member(teamName, "team-lead", `/tmp/${teamName}-lead.jsonl`),
      member(teamName, "worker", `/tmp/${teamName}-worker.jsonl`),
    ]);
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const tool = harness().tools.get("task_update")!;
    const createdResult = await harness().tools.get("task_create")!.execute("create", {
      tasks: [{ operation_id: "create-semantic", title: "semantic", goal: "one agent call", assignee: "worker" }],
    }, undefined, undefined, { sessionManager: { getSessionFile: () => `/tmp/${teamName}-lead.jsonl` } });
    const created = createdResult.details.outcomes[0].task;
    const traceFile = path.join(tempRoot("semantic-trace"), "trace.jsonl");
    vi.stubEnv("PI_TEAMS_TRACE_JSONL", traceFile);
    const result = await tool.execute("semantic", {
      updates: [{ task_id: created.id, operation_id: "semantic", status: "in_progress", current_context: "One native mutation.", journal_entries: [{ kind: "result", text: "One native mutation." }], expected_version: created.version }],
    }, undefined, undefined, { sessionManager: { getSessionFile: () => `/tmp/${teamName}-lead.jsonl` } });
    expect(result.details).toMatchObject({ kind: "task_update_batch", outcomes: [{ kind: "updated", task: { id: created.id, status: "in_progress", assignee: "worker" }, operation_id: "semantic" }] });
    const trace = fs.readFileSync(traceFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    expect(trace.bdCalls.filter((call: any) => call.command === "update")).toHaveLength(1);
  }, 60_000);

  it("uses a short expected_version ref and rejects a supplied stale ref before mutation", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("optional-version");
    writeTeam(teamName, workspace, [member(teamName, "team-lead", `/tmp/${teamName}-lead.jsonl`)]);
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const tool = harness().tools.get("task_update")!;
    const create = await harness().tools.get("task_create")!.execute("create", { tasks: [{ operation_id: "create-version", title: "version", goal: "v0" }] }, undefined, undefined, { sessionManager: { getSessionFile: () => `/tmp/${teamName}-lead.jsonl` } });
    const created = create.details.outcomes[0].task;
    const firstUpdate = await tool.execute("first-update", { updates: [{ task_id: created.id, operation_id: "first-update", status: "in_progress", current_context: "v1", journal_entries: [{ kind: "progress", text: "v1" }], expected_version: created.version }] }, undefined, undefined, { sessionManager: { getSessionFile: () => `/tmp/${teamName}-lead.jsonl` } });
    const current = firstUpdate.details.outcomes[0].task;
    const stale = await tool.execute("stale", { updates: [{ task_id: created.id, operation_id: "stale", status: "open", current_context: "stale", journal_entries: [{ kind: "blocker", text: "stale" }], expected_version: created.version }] }, undefined, undefined, { sessionManager: { getSessionFile: () => `/tmp/${teamName}-lead.jsonl` } });
    expect(stale.details).toMatchObject({ kind: "task_update_batch", outcomes: [{ kind: "refused", reason: "version_conflict", task_id: created.id, current_task: { status: "in_progress", version: current.version }, state_changed: false }] });
    expect(current.version).not.toBe(created.version);
  }, 60_000);

  it("rejects claim combined with another mutation and keeps graph edits on task_link", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("unsafe-composite");
    writeTeam(teamName, workspace, [member(teamName, "team-lead", `/tmp/${teamName}-lead.jsonl`)]);
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const tool = harness().tools.get("task_update")!;
    const create = await harness().tools.get("task_create")!.execute("create", { tasks: [{ operation_id: "create-target", title: "target", goal: "unchanged" }] }, undefined, undefined, { sessionManager: { getSessionFile: () => `/tmp/${teamName}-lead.jsonl` } });
    const target = create.details.outcomes[0].task;
    const ctx = { sessionManager: { getSessionFile: () => `/tmp/${teamName}-lead.jsonl` } };
    const duplicate = await tool.execute("duplicate", { updates: [
      { task_id: target.id, operation_id: "one", current_context: "unchanged", journal_entries: [{ kind: "note", text: "one" }], expected_version: target.version },
      { task_id: target.id, operation_id: "two", current_context: "unchanged", journal_entries: [{ kind: "note", text: "two" }], expected_version: target.version },
    ] }, undefined, undefined, ctx);
    expect(duplicate.details).toMatchObject({ kind: "refused", reason: "duplicate_task_id", state_changed: false });
    expect(tool.parameters.properties).not.toHaveProperty("blocked_by");
    expect(tool.parameters.properties).not.toHaveProperty("progress");
  }, 60_000);
});

describe("canonical Task versions", () => {
  it("is stable across timestamp formatting and changes for a same-timestamp logical mutation", async () => {
    const raw = (description: string, updatedAt: string) => ({
      id: "bd-version",
      title: "Version probe",
      description,
      status: "open",
      labels: ["pi-teams:version-probe"],
      metadata: { pi_teams_team: "version-probe" },
      updated_at: updatedAt,
      dependencies: [],
      comments: [],
    });
    const responses = [
      // create response preserves sub-second precision
      raw("v0", "2026-07-15T00:00:00.123456Z"),
      // immediate show/list expose the same state at whole-second precision
      [raw("v0", "2026-07-15T00:00:00Z")],
      [raw("v0", "2026-07-15T00:00:00Z")],
      [raw("v0", "2026-07-15T00:00:00Z")],
      // update returns sparse/full backend output, then show still has the
      // same timestamp even though the logical state changed.
      raw("v1", "2026-07-15T00:00:00Z"),
      [raw("v1", "2026-07-15T00:00:00Z")],
    ];
    const runner: BdRunner = {
      run: vi.fn(async () => ({
        stdout: JSON.stringify(responses.shift()),
        stderr: "",
        exitCode: 0,
      })),
    };
    const store = new BeadsTaskStore({
      teamName: "version-probe",
      workspace: "/tmp/version-probe",
      runner,
      requireExpectedVersion: false,
    });

    const created = await createTask(store, "Version probe", "v0");
    const read = await store.read(created.id);
    expect(read.version).toBe(created.version);
    const updated = await store.update(created.id, { description: "v1" });
    expect(updated.version).not.toBe(created.version);
  });
});

describe.skipIf(!hasBd)("trace, recovery, retention, and shutdown evidence", () => {
  it("emits secret-free trace JSONL with exact command counts, timings, and lock wait", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("trace");
    const traceFile = path.join(tempRoot("trace"), "pi-teams-trace.jsonl");
    writeTeam(teamName, workspace, [member(teamName, "team-lead", `/tmp/${teamName}-lead.jsonl`)]);
    vi.stubEnv("PI_TEAMS_TRACE_JSONL", traceFile);
    const secret = "SECRET_PAYLOAD_NEVER_TRACE_9f6288";
    const store = new BeadsTaskStore({ teamName, workspace, requireExpectedVersion: false });
    const created = await createTask(store, secret, secret);
    const lockFile = path.join(paths.teamDir(teamName), `.beads-task-${created.id}.lock`);
    fs.writeFileSync(lockFile, "external-holder", { flag: "wx" });
    setTimeout(() => fs.rmSync(lockFile, { force: true }), 150);

    await applySemanticTaskUpdate(teamName, created.id, { status: "in_progress" }, {
      actor: "team-lead",
      actingSessionFile: `/tmp/${teamName}-lead.jsonl`,
    } as any);

    expect(fs.existsSync(traceFile)).toBe(true);
    const raw = fs.readFileSync(traceFile, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(workspace);
    const records = raw.trim().split("\n").map((line) => JSON.parse(line));
    const operation = records.find((record) => record.operation === "task_update" && record.taskId === created.id);
    expect(operation).toMatchObject({
      schemaVersion: 1,
      teamName,
      operation: "task_update",
      outcome: "ok",
      durationMs: expect.any(Number),
      bdCallCount: expect.any(Number),
      bdTotalMs: expect.any(Number),
      bdCalls: expect.any(Array),
      lockWaitMs: expect.any(Number),
    });
    expect(operation.bdCallCount).toBe(operation.bdCalls.length);
    expect(operation.bdCallCount).toBeGreaterThan(0);
    expect(operation.bdTotalMs).toBeGreaterThan(0);
    expect(operation.lockWaitMs).toBeGreaterThanOrEqual(50);
    for (const command of operation.bdCalls) {
      expect(command).toEqual(expect.objectContaining({ command: expect.any(String), durationMs: expect.any(Number), outcome: expect.any(String) }));
      expect(Object.keys(command).sort()).toEqual(["command", "durationMs", "outcome"]);
    }
  }, 60_000);

  it("persists targeted recovery evidence when live enqueue fails after Task commit", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("recovery-marker");
    const workerSession = `/tmp/${teamName}-worker.jsonl`;
    writeTeam(teamName, workspace, [
      member(teamName, "team-lead", `/tmp/${teamName}-lead.jsonl`),
      member(teamName, "worker", workerSession),
    ]);
    const store = new BeadsTaskStore({ teamName, workspace, requireExpectedVersion: false });
    const created = await createTask(store, "recovery", "commit wins");
    const spool = paths.taskDeliveryPath(teamName, "worker");
    const originalRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (target === spool) throw new Error("fault after Task commit");
      return originalRename(source, target);
    });

    const receipt = await applySemanticTaskUpdate(teamName, created.id, { assignee: "worker" }, {
      actor: "team-lead",
      actingSessionFile: `/tmp/${teamName}-lead.jsonl`,
      expectedVersion: created.version,
      taskMetadata: { schema: TASK_METADATA_SCHEMA, goal: "commit wins", current_context: "The Task is ready for canonical delivery." },
      taskCardProjector: projectTaskCard,
    });
    const committed = receipt.task;
    expect((await store.read(created.id)).assignee).toBe("worker");
    expect(fs.existsSync(spool)).toBe(false);
    expect(receipt.deliveryDegraded).toBe(true);

    const markers = JSON.parse(fs.readFileSync(paths.taskOwnerTransitionOutboxPath(teamName), "utf8"));
    expect(markers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state: "committed",
        taskId: committed.id,
        committedTaskProjection: expect.objectContaining({ version: taskVersionRef(committed.version), goal: "commit wins" }),
        targets: [expect.objectContaining({ recipient: "worker", changeKind: "assigned" })],
      }),
    ]));
  }, 60_000);

  it("compacts only observed spool history, never pending critical records, and backpressures visibly", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("compaction");
    const recipient = "worker";
    const sessionFile = `/tmp/${teamName}-worker.jsonl`;
    const config = writeTeam(teamName, workspace, [member(teamName, recipient, sessionFile)]);
    const file = paths.taskDeliveryPath(teamName, recipient);
    const ref = (index: number) => ({
      kind: "task" as const,
      taskId: `task-${index}`,
      version: taskVersionRef(`v${index}`),
    });
    const record = (index: number, changeKind: string, status: TaskCard["status"], observed: boolean) => ({
      deliveryId: `delivery-${index}`,
      ref: ref(index),
      changeKind,
      teamName,
      recipient,
      recipientSessionFile: sessionFile,
      targetAgentRef: { kind: "session-trace", nativeId: `session-${index}` },
      taskProjection: taskCard({ id: `task-${index}`, version: taskVersionRef(`v${index}`), assignee: recipient, status }),
      queuedAt: new Date(index * 1000).toISOString(),
      attemptCount: observed ? 1 : 0,
      ...(observed ? { successfulTurnAckAt: new Date(index * 1000 + 1).toISOString() } : {}),
    });
    writeJsonAtomic(file, [
      record(1, "task_changed", "in_progress", true),
      record(2, "ownership_lost", "in_progress", false),
      record(3, "status_changed", "blocked", false),
      record(4, "status_changed", "closed", false),
      record(5, "task_changed", "in_progress", true),
    ]);
    // Any spool mutation runs compaction: observed evidence is bounded while
    // every pending delivery remains durable.
    await enqueueTaskChangeForRecipient(teamName, taskCard({ id: "trigger", version: taskVersionRef("v-trigger"), assignee: recipient }), recipient, "task_changed");
    expect((await readTaskDeliveries(teamName, recipient)).map((item) => item.deliveryId)).toEqual(expect.arrayContaining([
      "delivery-2", "delivery-3", "delivery-4",
    ]));

    const allCritical = Array.from({ length: 300 }, (_, index) =>
      record(index + 100, index % 3 === 0 ? "ownership_lost" : "status_changed", index % 3 === 1 ? "blocked" : "closed", false));
    writeJsonAtomic(file, allCritical);
    await enqueueTaskChangeForRecipient(teamName, taskCard({ id: "critical-trigger", version: taskVersionRef("v-critical"), assignee: recipient }), recipient, "task_changed");
    // This design has no hard pending cap, so it doesn't need a lossy
    // `backpressure` branch: all 300 critical pending records survive.
    expect((await readTaskDeliveries(teamName, recipient)).filter((item) => item.deliveryId.startsWith("delivery-"))).toHaveLength(300);
  }, 60_000);

  it("retains more than 256 targeted recovery markers or reports explicit backpressure", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("recovery-retention");
    writeTeam(teamName, workspace, [member(teamName, "worker", `/tmp/${teamName}-worker.jsonl`)]);
    const config = await teams.readConfig(teamName);
    for (let index = 0; index < 300; index++) {
      await recordTaskDeliveryRecovery({
        teamName,
        taskId: `task-${index}`,
        taskVersion: taskVersionRef(`v${index}`),
        recipients: ["worker"],
        changeKind: "task_changed",
        recordedAt: new Date().toISOString(),
        reason: "enqueue-failed",
        taskProjection: taskCard({ id: `task-${index}`, version: taskVersionRef(`v${index}`), assignee: "worker" }),
      });
    }
    expect(config.taskAuthorityId).toBeDefined();
    const markers = JSON.parse(fs.readFileSync(paths.taskDeliveryRecoveryPath(teamName), "utf8"));
    expect(markers).toHaveLength(300);
  }, 60_000);

  it("ends current membership, preserves history, rejects new Messages, and reports orphan bindings on shutdown", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("membership-history");
    const lead = member(teamName, "team-lead", `/tmp/${teamName}-lead.jsonl`);
    const worker = { ...member(teamName, "worker", `/tmp/${teamName}-worker.jsonl`), tmuxPaneId: "%historical" };
    writeTeam(teamName, workspace, [lead, worker]);

    await teams.deactivateMember(teamName, "worker", "process_shutdown");
    const config = await teams.readConfig(teamName);
    expect(config.members).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "worker",
        sessionFile: worker.sessionFile,
        tmuxPaneId: "%historical",
        isActive: false,
        deactivatedAt: expect.any(String),
      }),
    ]));
    await expect(messaging.sendPlainMessage(teamName, "team-lead", "worker", "late", "late"))
      .rejects.toThrow(/not a current member/i);

    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const shutdown = harness().tools.get("team_shutdown")!;
    const result = await shutdown.execute("shutdown", {}, undefined, undefined, {
      sessionManager: { getSessionFile: () => lead.sessionFile },
    });
    expect(result.details).toMatchObject({ kind: "team_shutdown", lifecycle: "stopped", stopped_workers: expect.any(Array) });
    expect(JSON.stringify(result.details)).not.toContain(worker.sessionFile);
    const afterShutdown = await teams.readConfig(teamName);
    expect(afterShutdown.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "worker", sessionFile: worker.sessionFile, isActive: false }),
      expect.objectContaining({ name: "team-lead", sessionFile: lead.sessionFile, isActive: false }),
    ]));
  }, 60_000);
});
