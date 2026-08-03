import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import type { TeamConfig } from "./models";
import * as messaging from "./messaging";
import * as paths from "./paths";
import * as runtime from "./runtime";
import {
  DIRECT_MESSAGE_CUSTOM_TYPE,
} from "./message-delivery";
import {
  TASK_CHANGE_CUSTOM_TYPE,
  TASK_CHANGE_ACK_ENTRY_TYPE,
  TaskChangeDelivery,
  enqueueTaskChange,
  readTaskDeliveries,
} from "./task-delivery";
import { BeadsTaskStore, readBeadsAuthorityFingerprint } from "./beads";
import * as teams from "./teams";
import { MODEL_TOOL_IMPLEMENTATION_VERSION } from "../../src/model-tool-contract/model-tool-constants";
import { taskVersionRef } from "../../src/model-tool-contract/task-version-ref";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: any,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: any,
  ) => Promise<any>;
};

type Handler = (event: any, ctx: any) => Promise<any>;

const testTeams: string[] = [];
const testRoots: string[] = [];
const hasBd = spawnSync("bd", ["--version"], { stdio: "ignore" }).status === 0;

// This evaluator exercises real `bd` workspaces and fsync-backed durability.
// Parallel full-suite load can exceed Vitest's unit-test-oriented 5s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function uniqueTeam(suffix: string): string {
  const name = `clean-cut-${suffix}-${process.pid}-${Date.now()}-${testTeams.length}`;
  testTeams.push(name);
  return name;
}

function tempRoot(suffix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-teams-${suffix}-`));
  testRoots.push(root);
  return root;
}

function writeTeam(
  name: string,
  options: {
    workerSession?: string;
    taskWorkspace?: string;
    legacy?: boolean;
  } = {},
): TeamConfig {
  fs.mkdirSync(paths.teamDir(name), { recursive: true });
  fs.mkdirSync(paths.taskDir(name), { recursive: true });
  const taskWorkspace = options.legacy
    ? ""
    : options.taskWorkspace || (hasBd ? initBeadsWorkspace() : path.join(tempRoot("declared-workspace"), "beads"));
  const config: TeamConfig = {
    name,
    description: "clean-cut evaluator fixture",
    implementationVersion: MODEL_TOOL_IMPLEMENTATION_VERSION,
    createdAt: Date.now(),
    epochId: teams.newTeamEpochId(),
    leadAgentId: "lead-agent",
    leadSessionId: "lead-session",
    members: [
      {
        membershipId: `membership_lead_${name}`,
        agentId: `lead@${name}`,
        name: "team-lead",
        agentType: "lead",
        joinedAt: Date.now(),
        tmuxPaneId: "",
        cwd: process.cwd(),
        subscriptions: [],
        sessionFile: "lead-session",
      },
      ...(options.workerSession
          ? [{
            membershipId: `membership_worker_${name}`,
            agentId: `worker@${name}`,
            name: "worker",
            agentType: "teammate",
            joinedAt: Date.now(),
            tmuxPaneId: "",
            sessionFile: options.workerSession,
            cwd: process.cwd(),
            subscriptions: [],
          }]
        : []),
    ],
    logicalWorkers: options.workerSession ? [{ name: "worker", scope: "clean-cut worker capability" }] : [],
    ...(options.legacy
      ? {}
      : {
          taskBackend: "beads" as const,
          taskWorkspace,
          taskAuthorityId: `task_authority_${crypto.randomUUID()}`,
          taskAuthorityFingerprint: hasBd
            ? readBeadsAuthorityFingerprint(taskWorkspace)
            : { schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: "test", projectId: "test" },
        }),
  };
  teams.writeConfigAtomic(paths.configPath(name), config);
  return config;
}

function extensionHarness() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler>();
  const sendMessage = vi.fn();
  const appendEntry = vi.fn();
  const sendUserMessage = vi.fn();
  piTeams({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    sendMessage,
    appendEntry,
    sendUserMessage,
  } as never);
  return { tools, handlers, sendMessage, appendEntry, sendUserMessage };
}

function sessionContext(sessionFile: string) {
  return {
    isIdle: vi.fn(() => false),
    sessionManager: {
      getSessionFile: vi.fn(() => sessionFile),
      buildContextEntries: vi.fn(() => []),
    },
    ui: { setStatus: vi.fn(), notify: vi.fn(), setTitle: vi.fn() },
  };
}

function initBeadsWorkspace(): string {
  const workspace = path.join(tempRoot("beads-workspace"), "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks"], {
    cwd: workspace,
    stdio: "ignore",
  });
  return workspace;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const name of testTeams.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
  for (const root of testRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("clean-cut public contract", () => {
  it("gives standalone and exact leader Sessions the leader surface without a prompt injection", async () => {
    const leaderName = uniqueTeam("leader-surface");
    writeTeam(leaderName);
    const expectedLeaderTools = [
      "alert_send", "ensure_worker", "task_create", "task_link", "task_read",
      "task_update", "team_create", "team_shutdown", "team_sync", "worker_stop",
    ];

    for (const [teamName, sessionFile] of [
      ["", "/tmp/standalone.jsonl"],
      [leaderName, "lead-session"],
    ]) {
      vi.stubEnv("PI_AGENT_NAME", "");
      vi.stubEnv("PI_TEAM_NAME", teamName);
      const harness = extensionHarness();
      expect([...harness.tools.keys()].sort()).toEqual(expectedLeaderTools);
      await expect(harness.handlers.get("before_agent_start")?.(
        { systemPrompt: "base" },
        sessionContext(sessionFile),
      )).resolves.toBeUndefined();
    }
  });

  it("gives a Worker only its Task and Alert tools and its Worker prompt", async () => {
    const workerName = uniqueTeam("worker-surface");
    const workerSession = `/tmp/${workerName}-worker.jsonl`;
    writeTeam(workerName, { workerSession });
    vi.stubEnv("PI_TEAM_NAME", workerName);
    vi.stubEnv("PI_AGENT_NAME", "worker");
    const harness = extensionHarness();

    expect([...harness.tools.keys()].sort()).toEqual(["alert_send", "task_read", "task_update"]);
    const beforeStart = await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "base" },
      sessionContext(workerSession),
    );
    expect(beforeStart?.systemPrompt).toContain("You are Worker 'worker' on Team");
    expect(beforeStart?.systemPrompt).toContain("Assigned Tasks are your work contracts");
    expect(beforeStart?.systemPrompt).not.toContain("Use the ten-tool release candidate as the Team leader");

    const extension = fs.readFileSync(path.join(process.cwd(), "extensions/index.ts"), "utf8");
    expect(extension).not.toContain("leaderPreviewProcess");
    expect(extension).not.toContain("previewJourney");
    expect(extension).not.toContain("(pi as any).registerTool =");
  });

  it("removes delivery feature flags and the synthetic inbox bootstrap from the shipped surface", () => {
    const extension = fs.readFileSync(path.join(process.cwd(), "extensions/index.ts"), "utf8");
    const messageDelivery = fs.readFileSync(path.join(process.cwd(), "src/utils/message-delivery.ts"), "utf8");
    const taskDelivery = fs.readFileSync(path.join(process.cwd(), "src/utils/task-delivery.ts"), "utf8");
    const tasks = fs.readFileSync(path.join(process.cwd(), "src/utils/tasks.ts"), "utf8");
    const docs = ["README.md", "docs/current/README.md", "docs/reference.md", "skills/pi-team-bright/SKILL.md"]
      .map((file) => fs.readFileSync(path.join(process.cwd(), file), "utf8"))
      .join("\n");

    for (const removed of ["PI_TEAMS_MESSAGE_DELIVERY", "PI_TEAMS_TASK_DELIVERY"]) {
      expect(`${extension}\n${messageDelivery}\n${taskDelivery}\n${tasks}\n${docs}`).not.toContain(removed);
    }
    expect(extension).not.toContain("sendUserMessage(");
    expect(extension).not.toContain("startLeadInboxPolling");
    expect(extension).not.toContain("teammatePollingTimer");
    expect(extension).not.toMatch(/Start by calling read_inbox/);
  });

  it("delivers accepted direct Messages as steer by default and never uses read_inbox as delivery", async () => {
    vi.stubEnv("TMUX", "");
    const name = uniqueTeam("message-default");
    const sessionFile = `/tmp/${name}.jsonl`;
    writeTeam(name, { workerSession: sessionFile });
    const worker = await teams.currentMembership(name, "worker");
    await runtime.writeRuntimeStatus(name, "worker", { pid: process.pid, startedAt: Date.now() }, worker.membershipId);
    vi.stubEnv("PI_TEAM_NAME", name);
    vi.stubEnv("PI_AGENT_NAME", "worker");
    const accepted = await messaging.sendPlainMessage(
      name,
      "team-lead",
      "worker",
      "full body is already in context",
      "do work",
    );

    const harness = extensionHarness();
    const ctx = sessionContext(sessionFile);
    await harness.handlers.get("session_start")?.({ reason: "resume" }, ctx);

    const direct = harness.sendMessage.mock.calls.find(
      ([message]) => message.customType === DIRECT_MESSAGE_CUSTOM_TYPE,
    );
    expect(direct).toBeDefined();
    expect(direct?.[0]).toMatchObject({
      details: { teamName: name, recipient: "worker", messageIds: [accepted.id] },
    });
    expect(direct?.[0].content).toContain("full body is already in context");
    expect(direct?.[1]).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(harness.sendUserMessage).not.toHaveBeenCalled();

    const beforeStart = await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "base" },
      ctx,
    );
    expect(beforeStart?.systemPrompt).toContain("delivered in context");
    expect(beforeStart?.systemPrompt).toContain("call task_update yourself to set it closed");
    expect(beforeStart?.systemPrompt).toContain("Use alert_send only for exceptional clarification or escalation");
    expect(beforeStart?.systemPrompt).not.toContain("Start by calling read_inbox");
    await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  });

  it("delivers accepted Task changes as steer by default without creating a Message", async () => {
    vi.stubEnv("TMUX", "");
    const name = uniqueTeam("task-default");
    const sessionFile = `/tmp/${name}.jsonl`;
    writeTeam(name, { workerSession: sessionFile });
    const worker = await teams.currentMembership(name, "worker");
    await runtime.writeRuntimeStatus(name, "worker", { pid: process.pid, startedAt: Date.now() }, worker.membershipId);
    vi.stubEnv("PI_TEAM_NAME", name);
    vi.stubEnv("PI_AGENT_NAME", "worker");
    const task = {
      id: "task-1",
      title: "Act on the Task authority",
      description: "complete payload",
      acceptanceCriteria: "The authoritative change is applied",
      status: "in_progress" as const,
      relations: [],
      assignee: "worker",
      version: "v1",
      provenance: { authority: "beads" as const, teamName: name },
    };
    await enqueueTaskChange(name, task, "assigned", "team-lead");

    const harness = extensionHarness();
    const ctx = sessionContext(sessionFile);
    await harness.handlers.get("session_start")?.({ reason: "resume" }, ctx);

    const taskCall = harness.sendMessage.mock.calls.find(
      ([message]) => message.customType === TASK_CHANGE_CUSTOM_TYPE,
    );
    expect(taskCall).toBeDefined();
    expect(taskCall?.[0]).toMatchObject({
      details: {
        teamName: name,
        recipient: "worker",
        changes: [{ ref: { nativeId: task.id, version: task.version } }],
      },
    });
    expect(taskCall?.[0].content).toContain("complete payload");
    expect(taskCall?.[1]).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(await messaging.readInbox(name, "worker", false, false)).toEqual([]);
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  });
});

describe("Beads-only authority and migration boundary", () => {
  it.skipIf(!hasBd)("initializes a Team-owned Beads authority when no override is configured", async () => {
    vi.stubEnv("PI_TEAMS_BEADS_WORKSPACE", "");
    const name = uniqueTeam("team-owned-workspace");
    const create = extensionHarness().tools.get("team_create")!;
    const result = await create.execute("create", { name, purpose: "clean-cut evaluator fixture" }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "/tmp/team-owned-lead.jsonl", buildContextEntries: () => [] },
      ui: { setStatus: vi.fn() },
    });
    expect(result.details).toMatchObject({
      kind: "team_created",
      team: { name, lifecycle: "active", purpose: "clean-cut evaluator fixture" },
    });
    const config = await teams.readConfig(name) as TeamConfig & { taskAuthorityId?: string };

    expect(config).toMatchObject({
      taskBackend: "beads",
      taskWorkspace: paths.teamDir(name),
    });
    expect(config.taskAuthorityId).toMatch(/^task_authority_[0-9a-f-]+$/);
    expect(readBeadsAuthorityFingerprint(paths.teamDir(name))).toEqual(config.taskAuthorityFingerprint);
    expect(fs.existsSync(paths.taskDir(name))).toBe(false);
  });

  it("fails closed when an explicit workspace override is unhealthy", async () => {
    const unhealthyRoot = tempRoot("unhealthy-workspace");
    vi.stubEnv("PI_TEAMS_BEADS_WORKSPACE", unhealthyRoot);
    const unhealthy = uniqueTeam("unhealthy-workspace");
    const unhealthyCreate = extensionHarness().tools.get("team_create")!;
    const unhealthyResult = await unhealthyCreate.execute("create", { name: unhealthy, purpose: "clean-cut evaluator fixture" }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "/tmp/unhealthy-lead.jsonl", buildContextEntries: () => [] },
      ui: { setStatus: vi.fn() },
    });
    expect(unhealthyResult.details).toMatchObject({ kind: "unavailable", reason: "task_authority_unavailable" });
    expect(unhealthyResult.details.message).toMatch(/initialized Beads|Beads workspace|bd/i);
    expect(fs.existsSync(paths.configPath(unhealthy))).toBe(false);
  });

  it.skipIf(!hasBd)("honors an explicit initialized Beads authority override", async () => {
    const workspace = initBeadsWorkspace();
    vi.stubEnv("PI_TEAMS_BEADS_WORKSPACE", workspace);
    const name = uniqueTeam("new-beads-team");
    const create = extensionHarness().tools.get("team_create")!;
    const result = await create.execute("create", { name, purpose: "clean-cut evaluator fixture" }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "/tmp/new-lead.jsonl", buildContextEntries: () => [] },
      ui: { setStatus: vi.fn() },
    });
    expect(result.details).toMatchObject({
      kind: "team_created",
      team: { name, lifecycle: "active", purpose: "clean-cut evaluator fixture" },
    });
    const config = await teams.readConfig(name) as TeamConfig & { taskAuthorityId?: string };

    expect(config).toMatchObject({ taskBackend: "beads", taskWorkspace: workspace });
    expect(config.taskAuthorityId).toMatch(/^task_authority_[0-9a-f-]+$/);
    expect(fs.existsSync(paths.taskDir(name))).toBe(false);
  });

  it.skipIf(!hasBd)("rejects team creation in an uninitialized child of another Beads authority", async () => {
    const parentWorkspace = initBeadsWorkspace();
    const childWorkspace = path.join(parentWorkspace, "uninitialized-child");
    fs.mkdirSync(childWorkspace);
    vi.stubEnv("PI_TEAMS_BEADS_WORKSPACE", childWorkspace);
    const name = uniqueTeam("nested-wrong-authority");
    const create = extensionHarness().tools.get("team_create")!;

    const nestedResult = await create.execute("create", { name, purpose: "clean-cut evaluator fixture" }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "/tmp/nested-wrong-authority-lead.jsonl", buildContextEntries: () => [] },
      ui: { setStatus: vi.fn() },
    });
    expect(nestedResult.details).toMatchObject({ kind: "unavailable", reason: "task_authority_unavailable" });
    expect(nestedResult.details.message).toMatch(/not an initialized authority root|exact workspace/i);
    expect(fs.existsSync(paths.configPath(name))).toBe(false);
  });

  it.skipIf(!hasBd)("uses the persisted opaque Task authority ID when workspace spelling changes", async () => {
    const workspace = initBeadsWorkspace();
    const alias = path.join(tempRoot("workspace-alias"), "beads-link");
    fs.symlinkSync(workspace, alias);
    vi.stubEnv("PI_TEAMS_BEADS_WORKSPACE", workspace);
    const name = uniqueTeam("opaque-authority");
    const sessionFile = `/tmp/${name}.jsonl`;
    const create = extensionHarness().tools.get("team_create")!;
    const result = await create.execute("create", { name, purpose: "clean-cut evaluator fixture" }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "/tmp/opaque-lead.jsonl", buildContextEntries: () => [] },
      ui: { setStatus: vi.fn() },
    });
    expect(result.details).toMatchObject({
      kind: "team_created",
      team: { name, lifecycle: "active", purpose: "clean-cut evaluator fixture" },
    });
    const created = await teams.readConfig(name) as TeamConfig & { taskAuthorityId?: string };
    expect(created.taskAuthorityId).toEqual(expect.any(String));
    await teams.addMember(name, {
      agentId: `worker@${name}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile,
      cwd: process.cwd(),
      subscriptions: [],
    });
    const rebound = await teams.readConfig(name) as TeamConfig & { taskAuthorityId?: string };
    teams.writeConfigAtomic(paths.configPath(name), { ...rebound, taskWorkspace: alias });
    const record = await enqueueTaskChange(name, {
      id: "task-opaque",
      title: "opaque authority",
      description: "workspace path is adapter config",
      acceptanceCriteria: "The authority reference stays opaque",
      status: "in_progress",
      assignee: "worker",
      relations: [],
      version: "v1",
      provenance: { authority: "beads", teamName: name },
    }, "assigned", "team-lead");

    expect(record?.ref.authorityId).toBe(created.taskAuthorityId);
    expect(record?.ref.authorityId).not.toContain(workspace);
    expect(record?.ref.authorityId).not.toContain(alias);
  });

  it("rejects an old public-release Team with one actionable migration command", async () => {
    const name = uniqueTeam("legacy-rejected");
    writeTeam(name, { legacy: true });
    fs.writeFileSync(path.join(paths.taskDir(name), "1.json"), JSON.stringify({
      id: "1",
      title: "legacy",
      description: "must migrate",
      status: "open",
      relations: [],
    }));
    const workspace = path.join(tempRoot("migration-target"), "workspace");
    vi.stubEnv("PI_TEAMS_BEADS_WORKSPACE", workspace);
    const create = extensionHarness().tools.get("team_create")!;

    const migrationResult = await create.execute("create", { name, purpose: "clean-cut evaluator fixture" }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "/tmp/lead.jsonl" },
      ui: { setStatus: vi.fn() },
    });
    expect(migrationResult.details).toMatchObject({ kind: "unavailable", reason: "task_authority_unavailable" });
    expect(migrationResult.details.message).toMatch(new RegExp(`npm run migrate:tasks -- ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(JSON.parse(fs.readFileSync(path.join(paths.taskDir(name), "1.json"), "utf8"))).toMatchObject({
      title: "legacy",
    });
  });
});

describe("durability and recovery", () => {
  it("never exposes a truncated inbox when the atomic replacement fails", async () => {
    const name = uniqueTeam("atomic-inbox");
    writeTeam(name);
    const first = await messaging.sendPlainMessage(name, "team-lead", "team-lead", "first", "first");
    const file = paths.inboxPath(name, "team-lead");
    const before = fs.readFileSync(file, "utf8");
    const originalRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (target === file) throw new Error("simulated rename failure");
      return originalRename(source, target);
    });

    await expect(messaging.sendPlainMessage(name, "team-lead", "team-lead", "second", "second"))
      .rejects.toThrow("simulated rename failure");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(JSON.parse(before)).toEqual([expect.objectContaining({ id: first.id, text: "first" })]);
  });

  it("never exposes a truncated Task delivery spool when atomic replacement fails", async () => {
    const name = uniqueTeam("atomic-task-spool");
    const sessionFile = `/tmp/${name}.jsonl`;
    writeTeam(name, { workerSession: sessionFile });
    const base = {
      id: "task-1",
      title: "first",
      description: "first snapshot",
      acceptanceCriteria: "The snapshot is delivered atomically",
      status: "in_progress" as const,
      relations: [],
      assignee: "worker",
      version: "v1",
      provenance: { authority: "beads" as const, teamName: name },
    };
    await enqueueTaskChange(name, base, "assigned", "team-lead");
    const file = paths.taskDeliveryPath(name, "worker");
    const before = fs.readFileSync(file, "utf8");
    const originalRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (target === file) throw new Error("simulated rename failure");
      return originalRename(source, target);
    });

    await expect(enqueueTaskChange(name, { ...base, description: "second", version: "v2" }, "status_changed", "team-lead"))
      .rejects.toThrow("simulated rename failure");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(JSON.parse(before)).toHaveLength(1);
  });

  it.skipIf(!hasBd)("reconciles a committed assigned Task whose delivery spool was lost before same-Session resume", async () => {
    vi.stubEnv("TMUX", "");
    const workspace = initBeadsWorkspace();
    const name = uniqueTeam("task-reconcile");
    const sessionFile = `/tmp/${name}.jsonl`;
    writeTeam(name, { workerSession: sessionFile, taskWorkspace: workspace });
    const worker = await teams.currentMembership(name, "worker");
    await runtime.writeRuntimeStatus(name, "worker", { pid: process.pid, startedAt: Date.now() }, worker.membershipId);
    vi.stubEnv("PI_TEAM_NAME", name);
    vi.stubEnv("PI_AGENT_NAME", "worker");
    const store = new BeadsTaskStore({
      teamName: name,
      workspace,
      actor: "team-lead",
      requireExpectedVersion: false,
    });
    const created = await store.create({ title: "committed", description: "survives fault" });
    const assigned = await store.update(created.id, { assignee: "worker", status: "in_progress" });
    expect(await readTaskDeliveries(name, "worker")).toEqual([]);

    const harness = extensionHarness();
    const ctx = sessionContext(sessionFile);
    await harness.handlers.get("session_start")?.({ reason: "resume" }, ctx);

    const rebuilt = await readTaskDeliveries(name, "worker");
    expect(rebuilt).toEqual([
      expect.objectContaining({
        ref: expect.objectContaining({ nativeId: assigned.id, version: assigned.version }),
        recipientSessionFile: sessionFile,
        taskSnapshot: expect.objectContaining({ description: "survives fault" }),
      }),
    ]);
    expect(harness.sendMessage.mock.calls.some(
      ([message]) => message.customType === TASK_CHANGE_CUSTOM_TYPE,
    )).toBe(true);
    await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  }, 60_000);

  it("makes the steer/Session fault cut explicitly at-least-once until successful-turn acknowledgement", async () => {
    const name = uniqueTeam("at-least-once");
    const sessionFile = `/tmp/${name}.jsonl`;
    writeTeam(name, { workerSession: sessionFile });
    const record = await enqueueTaskChange(name, {
      id: "task-once",
      title: "retry across crash",
      description: "same logical delivery may be attempted again",
      acceptanceCriteria: "The delivery survives a retry",
      status: "in_progress",
      assignee: "worker",
      relations: [],
      version: "v1",
      provenance: { authority: "beads", teamName: name },
    }, "assigned", "team-lead");
    expect(record).not.toBeNull();

    const firstSend = vi.fn();
    const first = new TaskChangeDelivery({ sendMessage: firstSend, appendEntry: vi.fn() }, {
      teamName: name,
      recipient: "worker",
      sessionFile,
    });
    await first.start([]);
    expect(firstSend).toHaveBeenCalledTimes(1);
    first.stop();

    // Process death before Pi persists the custom Message can retry the same
    // stable delivery ID. Consumers therefore deduplicate by ID, not attempt.
    const retrySend = vi.fn();
    const retry = new TaskChangeDelivery({ sendMessage: retrySend, appendEntry: vi.fn() }, {
      teamName: name,
      recipient: "worker",
      sessionFile,
    });
    await retry.start([]);
    expect(retrySend).toHaveBeenCalledTimes(1);
    expect(retrySend.mock.calls[0][0].details.deliveryIds).toEqual([record!.deliveryId]);
    retry.stop();

    const presented = {
      type: "custom_message",
      id: "presented",
      parentId: null,
      timestamp: "2026-07-14T00:00:00.000Z",
      customType: TASK_CHANGE_CUSTOM_TYPE,
      content: "canonical Task payload",
      display: true,
      details: retrySend.mock.calls[0][0].details,
    } as any;
    const observed = {
      type: "custom",
      id: "observed",
      parentId: "presented",
      timestamp: "2026-07-14T00:00:01.000Z",
      customType: TASK_CHANGE_ACK_ENTRY_TYPE,
      data: retrySend.mock.calls[0][0].details,
    } as any;
    const settledSend = vi.fn();
    const settled = new TaskChangeDelivery({ sendMessage: settledSend, appendEntry: vi.fn() }, {
      teamName: name,
      recipient: "worker",
      sessionFile,
    });
    await settled.start([presented, observed]);
    expect(settledSend).not.toHaveBeenCalled();
    expect((await readTaskDeliveries(name, "worker"))[0].successfulTurnAckAt).toEqual(expect.any(String));
    settled.stop();
  });

  it.skipIf(!hasBd)("commits terminal status and its explanatory note in one Task mutation", async () => {
    const name = uniqueTeam("terminal-state-atomicity");
    const config = writeTeam(name);
    const store = new BeadsTaskStore({ teamName: name, workspace: config.taskWorkspace!, requireExpectedVersion: false });
    const createResult = await extensionHarness().tools.get("task_create")!.execute("create", { tasks: [{ operation_id: "create-terminal-transition", title: "Terminal transition", goal: "Close with durable context." }] }, undefined, undefined, { sessionManager: { getSessionFile: () => "lead-session" } });
    const created = createResult.details.outcomes[0].task;
    const update = extensionHarness().tools.get("task_update")!;
    const result = await update.execute("update", {
      updates: [{
        task_id: created.id,
        operation_id: "terminal-close",
        status: "closed",
        current_context: "Acceptance criteria verified; closing the Task.",
        journal_entries: [{ kind: "result", text: "Acceptance criteria verified; closing the Task." }],
        expected_version: taskVersionRef(created.version),
      }],
    }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "lead-session" },
    });
    expect(result.details).toMatchObject({
      kind: "task_update_batch",
      outcomes: [{
        kind: "updated",
        task_id: created.id,
        operation_id: "terminal-close",
        task: { status: "closed", current_context: "Acceptance criteria verified; closing the Task." },
        journal_entries: [expect.objectContaining({ kind: "result", text: "Acceptance criteria verified; closing the Task." })],
      }],
    });
  });
});
