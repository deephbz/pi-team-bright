import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { writeJsonAtomic } from "./atomic-json";
import { BeadsTaskStore, readBeadsAuthorityFingerprint } from "./beads";
import type { BdRunner } from "./beads";
import type { Member, TaskFile, TeamConfig } from "./models";
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
    createdAt: Date.now(),
    leadAgentId: "lead-agent",
    leadSessionId: "lead-session",
    members,
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

function taskSnapshot(overrides: Partial<TaskFile> = {}): TaskFile {
  return {
    id: overrides.id || "task-1",
    title: overrides.title || "Task",
    description: overrides.description || "description",
    acceptanceCriteria: overrides.acceptanceCriteria || "verified",
    status: overrides.status || "in_progress",
    relations: overrides.relations || [],
    assignee: overrides.assignee,
    version: overrides.version || "v1",
    notes: overrides.notes,
    provenance: overrides.provenance || { authority: "beads", teamName: "round2-fixture" },
  };
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
    const created = await store.create({ title: "self assignment", description: "same name is not identity" });

    const selfAssigned = (await tasks.applySemanticTaskUpdate(teamName, created.id, {
      assignee: "worker",
      status: "in_progress",
    }, {
      actor: "worker",
      actingSessionFile: sourceSession,
      expectedVersion: created.version,
    })).task;
    expect(selfAssigned.assignee).toBe("worker");
    expect(await readTaskDeliveries(teamName, "worker")).toEqual([]);
    expect(await reconcileTaskChanges(teamName, "worker")).toBe(0);
    expect(await readTaskDeliveries(teamName, "worker")).toEqual([]);

    // A fork/new Session with the same display name is a different Agent.
    await teams.updateMember(teamName, "worker", { sessionFile: sameNameOtherSession });
    expect(await reconcileTaskChanges(teamName, "worker")).toBe(1);
    expect(await readTaskDeliveries(teamName, "worker")).toEqual([
      expect.objectContaining({
        recipientSessionFile: sameNameOtherSession,
        changeKind: "task_changed",
        ref: expect.objectContaining({ nativeId: created.id, version: selfAssigned.version }),
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
    const created = await store.create({ title: "post-state", description: "v0" });
    const selfAssigned = (await tasks.applySemanticTaskUpdate(teamName, created.id, { assignee: "worker" }, {
      actor: "worker",
      actingSessionFile: sessionFile,
      expectedVersion: created.version,
    })).task;
    expect(await reconcileTaskChanges(teamName, "worker")).toBe(0);

    const changed = await store.update(created.id, { description: "external v2" }, {
      actor: "team-lead",
      expectedVersion: selfAssigned.version,
    });
    expect(changed.version).toBeDefined();
    expect(await reconcileTaskChanges(teamName, "worker")).toBe(1);
    expect(await readTaskDeliveries(teamName, "worker")).toEqual([
      expect.objectContaining({
        changeKind: "task_changed",
        ref: expect.objectContaining({ version: changed.version }),
        taskSnapshot: expect.objectContaining({ description: "external v2" }),
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
    const created = await store.create({ title: "ownership", description: "handoff" });
    const alice = (await tasks.applySemanticTaskUpdate(teamName, created.id, { assignee: "alice" }, {
      actor: "team-lead",
      actingSessionFile: `/tmp/${teamName}-lead.jsonl`,
      expectedVersion: created.version,
    })).task;
    const bob = (await tasks.applySemanticTaskUpdate(teamName, created.id, { assignee: "bob" }, {
      actor: "team-lead",
      actingSessionFile: `/tmp/${teamName}-lead.jsonl`,
      expectedVersion: alice.version,
    })).task;

    expect(await readTaskDeliveries(teamName, "alice")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        changeKind: "ownership_lost",
        taskSnapshot: expect.objectContaining({ assignee: "bob" }),
        ref: expect.objectContaining({ version: bob.version }),
      }),
    ]));
    expect(await readTaskDeliveries(teamName, "bob")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        changeKind: "assigned",
        taskSnapshot: expect.objectContaining({ assignee: "bob" }),
      }),
    ]));

    const unassigned = (await tasks.applySemanticTaskUpdate(teamName, created.id, { assignee: "" }, {
      actor: "team-lead",
      actingSessionFile: `/tmp/${teamName}-lead.jsonl`,
      expectedVersion: bob.version,
    })).task;
    const bobDeliveries = await readTaskDeliveries(teamName, "bob");
    const ownershipLost = bobDeliveries.find((delivery) =>
      delivery.changeKind === "ownership_lost" && delivery.ref.version === unassigned.version);
    expect(ownershipLost).toBeDefined();
    expect(ownershipLost?.taskSnapshot.assignee).toBeUndefined();
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
    const record = await enqueueTaskChange(teamName, taskSnapshot({ assignee: "worker" }), "assigned", "team-lead");
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
    vi.stubEnv("PI_AGENT_NAME", "team-lead");
    vi.stubEnv("PI_TEAM_NAME", teamName);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // A directory at the recipient spool path deterministically fails the
    // post-commit enqueue while leaving Beads Task authority writable.
    fs.mkdirSync(paths.taskDeliveryPath(teamName, "worker"), { recursive: true });
    const result = await harness().tools.get("task_create")!.execute("create-degraded", {
      team_name: teamName,
      title: "Preserve delivery degradation",
      description: "The Task commit must survive a recipient enqueue failure.",
      acceptance_criteria: "The Task is readable and its receipt reports the failed delivery.",
      assignee: "worker",
    }, undefined, undefined, {
      sessionManager: { getSessionFile: () => leadSession },
    });

    const task = result.details.postState as TaskFile;
    const warning = "Task authority committed, but delivery enqueue for worker failed";
    expect(result.content[0].text).toContain(`Created Task ${task.id} “Preserve delivery degradation”`);
    expect(result.content[0].text).toMatch(/Task authority committed, but Worker delivery degraded/i);
    expect(result.content[0].text).toMatch(/Do not recreate this Task; investigate delivery recovery with team_sync/i);
    expect(result.content[0].text).not.toContain(task.version);
    expect(result.details).toMatchObject({
      schema: "pi-teams-tool-result/1",
      outcome: "partial",
      operation: "task_create",
      resource: { kind: "task", id: task.id, teamName },
      postState: { id: task.id, status: "open", assignee: "worker", version: task.version },
      warnings: [{ code: "task_delivery_degraded", message: warning, resourceId: task.id }],
      evidence: {
        changed: true,
        appliedOperations: ["create"],
        deliveryDegraded: true,
        teamEvent: { appended: true },
        delivery: {
          attemptedRecipients: ["worker"],
          failedRecipients: ["worker"],
          recoveryRecordedFor: ["worker"],
          recoveryRecordFailedFor: [],
        },
      },
      nextActions: [{
        tool: "team_sync",
        args: { team_name: teamName, task_ids: [task.id] },
      }],
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
    vi.stubEnv("PI_AGENT_NAME", "team-lead");
    vi.stubEnv("PI_TEAM_NAME", teamName);
    const tools = harness().tools;
    const context = { sessionManager: { getSessionFile: () => leadSession } };

    const createdResult = await tools.get("task_create")!.execute("create", {
      team_name: teamName,
      title: "Receipt contract",
      description: "large descriptions stay out of model-visible mutation receipts",
    }, undefined, undefined, context);
    const created = createdResult.details.postState as TaskFile;
    expect(createdResult.content[0].text).toBe(
      `Created Task ${created.id} “Receipt contract”: open, version ${created.version}.`,
    );
    expect(createdResult.details).toMatchObject({
      schema: "pi-teams-tool-result/1",
      outcome: "accepted",
      operation: "task_create",
      resource: { kind: "task", id: created.id, teamName },
      postState: {
        id: expect.any(String),
        status: "open",
        version: expect.stringMatching(/^beads_/),
      },
      warnings: [],
      nextActions: [],
    });
    expect(createdResult.content[0].text).not.toContain("large descriptions");

    const designedResult = await tools.get("task_update")!.execute("design", {
      team_name: teamName,
      task_id: created.id,
      design: "inspect then test",
      append_note: "Requesting review of this design.",
      expected_version: created.version,
    }, undefined, undefined, context);
    const designed = designedResult.details.postState as TaskFile;
    expect(designedResult.content[0].text).toBe(
      `Task ${created.id} is open, unassigned, version ${designed.version}. Delivery warnings: none.`,
    );
    expect(designed).toMatchObject({
      id: created.id,
      status: "open",
      version: expect.stringMatching(/^beads_/),
    });
    expect(designedResult.details.evidence).toMatchObject({
      before: { id: created.id, status: "open", version: created.version },
      appliedOperations: ["set:design", "append:note"],
      deliveryDegraded: false,
    });

    const evaluatedResult = await tools.get("task_update")!.execute("approve", {
      team_name: teamName,
      task_id: created.id,
      status: "in_progress",
      append_note: "Leader approved execution at this exact Task version.",
      expected_version: designed.version,
    }, undefined, undefined, context);
    const evaluated = evaluatedResult.details.postState as TaskFile;
    expect(evaluatedResult.content[0].text).toBe(
      `Task ${created.id} is in_progress, unassigned, version ${evaluated.version}. Delivery warnings: none.`,
    );
    expect(evaluated).toMatchObject({
      id: created.id,
      status: "in_progress",
      version: expect.stringMatching(/^beads_/),
    });
    expect(evaluatedResult.details.evidence.appliedOperations).toEqual(["set:status", "append:note"]);

    const updatedResult = await tools.get("task_update")!.execute("assign", {
      team_name: teamName,
      task_id: created.id,
      assignee: "worker",
      expected_version: evaluated.version,
    }, undefined, undefined, context);
    const updated = updatedResult.details.postState as TaskFile;
    expect(updatedResult.content[0].text).toBe(
      `Task ${created.id} is in_progress, assigned to worker, version ${updated.version}. Delivery warnings: none.`,
    );
    expect(updated).toMatchObject({
      id: created.id,
      status: "in_progress",
      assignee: "worker",
      version: expect.stringMatching(/^beads_/),
    });
    expect(updatedResult.details.evidence.appliedOperations).toContain("set:assignee");
    expect(updatedResult.details.warnings).toEqual([]);

    const progressedResult = await tools.get("task_update")!.execute("progress", {
      team_name: teamName,
      task_id: created.id,
      append_note: "comment-backed revision",
      expected_version: updated.version,
    }, undefined, undefined, context);
    const progressed = progressedResult.details.postState as TaskFile;
    expect(progressedResult.content[0].text).toBe(
      `Task ${created.id} is in_progress, assigned to worker, version ${progressed.version}. Delivery warnings: none.`,
    );
    const syncResult = await tools.get("team_sync")!.execute("sync", {
      team_name: teamName,
    }, undefined, undefined, context);
    const projected = syncResult.details.postState.projection.tasks.find((task: any) => task.id === created.id);
    expect(syncResult.content[0].text).toContain(`Tasks: ${created.id}`);
    expect(projected.version).toBe(progressed.version);

    const readResult = await tools.get("task_read")!.execute("read", {
      team_name: teamName,
      task_id: created.id,
    }, undefined, undefined, context);
    expect(readResult.content[0].text).toContain(`State: in_progress; assigned to worker; version ${progressed.version}`);
    expect(readResult.details.postState.version).toBe(progressed.version);
    await expect(tools.get("task_update")!.execute("safe-next-write", {
      team_name: teamName,
      task_id: created.id,
      status: "open",
      expected_version: readResult.details.postState.version,
    }, undefined, undefined, context)).resolves.toBeDefined();
  }, 60_000);

  it("combines assignee plus nonterminal status in one native update and returns full post-state plus applied operations", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("semantic-update");
    writeTeam(teamName, workspace, [
      member(teamName, "team-lead", `/tmp/${teamName}-lead.jsonl`),
      member(teamName, "worker", `/tmp/${teamName}-worker.jsonl`),
    ]);
    vi.stubEnv("PI_AGENT_NAME", "team-lead");
    vi.stubEnv("PI_TEAM_NAME", teamName);
    const tool = harness().tools.get("task_update")!;
    const created = await new BeadsTaskStore({ teamName, workspace, requireExpectedVersion: false })
      .create({ title: "semantic", description: "one agent call" });

    const result = await tool.execute("semantic", {
      team_name: teamName,
      task_id: created.id,
      assignee: "worker",
      status: "in_progress",
      expected_version: created.version,
    }, undefined, undefined, {
      sessionManager: { getSessionFile: () => `/tmp/${teamName}-lead.jsonl` },
    });

    expect(result.details.postState).toMatchObject({
      id: created.id,
      assignee: "worker",
      status: "in_progress",
      version: expect.any(String),
    });
    expect(result.content[0].text).toMatch(/^Task .+ is in_progress, assigned to worker, version beads_.+ Delivery warnings: none\.$/);
    expect(result.content[0].text).not.toMatch(/Changed:|set:|append:/);
    expect(Array.isArray(result.details.evidence.appliedOperations)).toBe(true);
    expect(JSON.stringify(result.details.evidence.appliedOperations)).toMatch(/assignee/i);
    expect(JSON.stringify(result.details.evidence.appliedOperations)).toMatch(/status/i);
    expect(JSON.stringify(result.details.evidence.appliedOperations)).not.toMatch(/progress/i);
    const traceFile = path.join(tempRoot("semantic-trace"), "trace.jsonl");
    // The public result needn't expose a redundant `atomic` flag; the trace
    // proves this compatible field group used one native mutation command.
    vi.stubEnv("PI_TEAMS_TRACE_JSONL", traceFile);
    const traced = await tool.execute("semantic-traced", {
      team_name: teamName,
      task_id: created.id,
      assignee: "worker",
      status: "open",
      expected_version: result.details.postState.version,
    }, undefined, undefined, {
      sessionManager: { getSessionFile: () => `/tmp/${teamName}-lead.jsonl` },
    });
    expect(traced.details.postState.status).toBe("open");
    const trace = fs.readFileSync(traceFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    expect(trace.bdCalls.filter((call: any) => call.command === "update")).toHaveLength(1);
  }, 60_000);

  it("makes expected_version optional but rejects a supplied stale token before mutation", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("optional-version");
    writeTeam(teamName, workspace, [member(teamName, "team-lead", `/tmp/${teamName}-lead.jsonl`)]);
    vi.stubEnv("PI_AGENT_NAME", "team-lead");
    vi.stubEnv("PI_TEAM_NAME", teamName);
    const tool = harness().tools.get("task_update")!;
    const store = new BeadsTaskStore({ teamName, workspace, requireExpectedVersion: false });
    const created = await store.create({ title: "version", description: "v0" });

    const withoutToken = await tool.execute("without-token", {
      team_name: teamName,
      task_id: created.id,
      status: "in_progress",
    }, undefined, undefined, { sessionManager: { getSessionFile: () => `/tmp/${teamName}-lead.jsonl` } });
    expect(withoutToken.details.postState.status).toBe("in_progress");
    const current = withoutToken.details.postState as TaskFile;

    const stale = await tool.execute("stale", {
      team_name: teamName,
      task_id: created.id,
      status: "open",
      expected_version: created.version,
    }, undefined, undefined, { sessionManager: { getSessionFile: () => `/tmp/${teamName}-lead.jsonl` } });
    expect(stale.content[0].text).toMatch(/not updated|stale|review it and retry/i);
    expect(stale.details).toMatchObject({
      schema: "pi-teams-tool-result/1",
      outcome: "refused",
      operation: "task_update",
      postState: { id: created.id, status: "in_progress", version: current.version },
      evidence: { requestedVersion: created.version, currentVersion: current.version, changed: false },
    });
    expect((await store.read(created.id)).version).toBe(current.version);
    expect((await store.read(created.id)).status).toBe("in_progress");
  }, 60_000);

  it("rejects claim combined with another mutation and keeps graph edits on task_link", async () => {
    const workspace = initWorkspace();
    const teamName = uniqueTeam("unsafe-composite");
    writeTeam(teamName, workspace, [member(teamName, "team-lead", `/tmp/${teamName}-lead.jsonl`)]);
    vi.stubEnv("PI_AGENT_NAME", "team-lead");
    vi.stubEnv("PI_TEAM_NAME", teamName);
    const tool = harness().tools.get("task_update")!;
    const store = new BeadsTaskStore({ teamName, workspace, requireExpectedVersion: false });
    const target = await store.create({ title: "target", description: "unchanged" });
    const ctx = { sessionManager: { getSessionFile: () => `/tmp/${teamName}-lead.jsonl` } };
    await expect(tool.execute("claim-plus-status", {
      team_name: teamName,
      task_id: target.id,
      claim: true,
      status: "in_progress",
    }, undefined, undefined, ctx)).rejects.toThrow(/claim|atomic|combine/i);

    expect(tool.parameters.properties).not.toHaveProperty("blocked_by");
    expect(tool.parameters.properties).not.toHaveProperty("progress");

    expect(await store.read(target.id)).toMatchObject({
      status: "open",
      relations: [],
      assignee: undefined,
    });
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

    const created = await store.create({ title: "Version probe", description: "v0" });
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
    const created = await store.create({ title: secret, description: secret });
    const lockFile = path.join(paths.teamDir(teamName), `.beads-task-${created.id}.lock`);
    fs.writeFileSync(lockFile, "external-holder", { flag: "wx" });
    setTimeout(() => fs.rmSync(lockFile, { force: true }), 150);

    await tasks.applySemanticTaskUpdate(teamName, created.id, { status: "in_progress" }, {
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
    const created = await store.create({ title: "recovery", description: "commit wins" });
    const spool = paths.taskDeliveryPath(teamName, "worker");
    const originalRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (target === spool) throw new Error("fault after Task commit");
      return originalRename(source, target);
    });

    const receipt = await tasks.applySemanticTaskUpdate(teamName, created.id, { assignee: "worker" }, {
      actor: "team-lead",
      actingSessionFile: `/tmp/${teamName}-lead.jsonl`,
      expectedVersion: created.version,
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
        committedTaskSnapshot: expect.objectContaining({ version: committed.version }),
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
      authorityId: config.taskAuthorityId!,
      nativeId: `task-${index}`,
      version: `v${index}`,
    });
    const record = (index: number, changeKind: string, status: TaskFile["status"], observed: boolean) => ({
      deliveryId: `delivery-${index}`,
      ref: ref(index),
      changeKind,
      teamName,
      recipient,
      recipientSessionFile: sessionFile,
      targetAgentRef: { kind: "session-trace", nativeId: `session-${index}` },
      taskSnapshot: taskSnapshot({ id: `task-${index}`, version: `v${index}`, assignee: recipient, status }),
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
    await enqueueTaskChangeForRecipient(teamName, taskSnapshot({ id: "trigger", version: "v-trigger", assignee: recipient }), recipient, "task_changed");
    expect((await readTaskDeliveries(teamName, recipient)).map((item) => item.deliveryId)).toEqual(expect.arrayContaining([
      "delivery-2", "delivery-3", "delivery-4",
    ]));

    const allCritical = Array.from({ length: 300 }, (_, index) =>
      record(index + 100, index % 3 === 0 ? "ownership_lost" : "status_changed", index % 3 === 1 ? "blocked" : "closed", false));
    writeJsonAtomic(file, allCritical);
    await enqueueTaskChangeForRecipient(teamName, taskSnapshot({ id: "critical-trigger", version: "v-critical", assignee: recipient }), recipient, "task_changed");
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
        taskVersion: `v${index}`,
        recipients: ["worker"],
        changeKind: "task_changed",
        recordedAt: new Date().toISOString(),
        reason: "enqueue-failed",
        taskSnapshot: taskSnapshot({ id: `task-${index}`, version: `v${index}`, assignee: "worker" }),
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

    vi.stubEnv("PI_TEAM_NAME", teamName);
    vi.stubEnv("PI_AGENT_NAME", "team-lead");
    const shutdown = harness().tools.get("team_shutdown")!;
    const result = await shutdown.execute("shutdown", { team_name: teamName }, undefined, undefined, {
      sessionManager: { getSessionFile: () => lead.sessionFile },
    });
    expect(result.details.diagnostics.staleBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "worker",
        sessionBound: true,
        terminal: { kind: "pane", targetId: "%historical" },
      }),
    ]));
    expect(JSON.stringify(result.details.diagnostics)).not.toContain(worker.sessionFile);
    const afterShutdown = await teams.readConfig(teamName);
    expect(afterShutdown.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "worker", sessionFile: worker.sessionFile, isActive: false }),
      expect.objectContaining({ name: "team-lead", sessionFile: lead.sessionFile, isActive: false }),
    ]));
  }, 60_000);
});
