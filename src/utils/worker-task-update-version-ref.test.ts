import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Check } from "typebox/value";
import piTeams from "../../extensions/index";
import { BeadsTaskStore, readBeadsAuthorityFingerprint } from "./beads";
import type { TeamConfig } from "./models";
import * as paths from "./paths";
import * as tasks from "./tasks";
import { createTask } from "../model-tool-contract/beads-authority-adapter";
import * as authority from "../model-tool-contract/beads-authority-adapter";
import * as teams from "./teams";
import { BeadsTaskAdapter, createPublishingBeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";
import type { TaskAuthorityTeamPort } from "../task-authority/contracts";
import { taskVersionRef, type TaskVersionRef } from "../model-tool-contract/task-version-ref";
import { readTaskDeliveries } from "./task-delivery";
import { readTeamEvents } from "./team-events";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { DurableTaskAuthorityRead } from "../adapters/durable-task-authority-read";
import { DurableTaskAuthorityReadTeam } from "../adapters/durable-task-authority-read-team";
import { createTaskAuthorityTeamPort } from "../../test/support/task-authority-team-port";
import { taskReadAdapterFactory } from "../../test/support/task-authority-read-port";

type Tool = { name: string; parameters: unknown; execute: (...args: any[]) => Promise<any> };

const testTeams: string[] = [];
const testRoots: string[] = [];
const publicationPort = new DurableTaskMutationPublication();
const taskAuthorityTeamPort = createTaskAuthorityTeamPort();
const taskAuthorityReadTeamPort = new DurableTaskAuthorityReadTeam();
const taskAuthorityRead = new DurableTaskAuthorityRead(taskAuthorityReadTeamPort);
const taskReadFactory = taskReadAdapterFactory(taskAuthorityRead);

function uniqueTeam(): string {
  const name = `worker-version-ref-${process.pid}-${Date.now()}-${testTeams.length}`;
  testTeams.push(name);
  return name;
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-worker-version-ref-"));
  testRoots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks"], { cwd: root, stdio: "ignore" });
  return root;
}

function member(teamName: string, name: string, agentType: "lead" | "teammate") {
  return {
    membershipId: `membership_${name}_${teamName}`,
    agentId: `${name}@${teamName}`,
    name,
    agentType,
    joinedAt: Date.now(),
    cwd: process.cwd(),
    subscriptions: [],
    sessionFile: `/tmp/${teamName}-${name}.jsonl`,
    isActive: true,
  };
}

function writeTeam(teamName: string, root: string): TeamConfig {
  const config: TeamConfig = {
    name: teamName,
    description: "Worker TaskVersionRef regression coverage",
    createdAt: Date.now(),
    epochId: teams.newTeamEpochId(),
    leadAgentId: `lead@${teamName}`,
    leadSessionId: `/tmp/${teamName}-team-lead.jsonl`,
    taskBackend: "beads",
    taskWorkspace: root,
    taskAuthorityId: `task_authority_${crypto.randomUUID()}`,
    taskAuthorityFingerprint: readBeadsAuthorityFingerprint(root),
    implementationVersion: "0.17.0-rc.3",
    logicalWorkers: [{ name: "worker", scope: "version-safe Worker mutations" }],
    members: [member(teamName, "team-lead", "lead"), member(teamName, "worker", "teammate")],
  };
  fs.mkdirSync(paths.teamDir(teamName), { recursive: true });
  teams.writeConfigAtomic(paths.configPath(teamName), config);
  return config;
}

function harness(teamName: string, actor: string): Map<string, Tool> {
  vi.stubEnv("PI_TEAM_NAME", teamName);
  vi.stubEnv("PI_AGENT_NAME", actor === "team-lead" ? "" : actor);
  vi.stubEnv("TMUX", "");
  const registered = new Map<string, Tool>();
  piTeams({ registerTool(tool: Tool) { registered.set(tool.name, tool); }, on() {}, sendMessage: vi.fn(), appendEntry: vi.fn() } as never);
  return registered;
}

function context(teamName: string, actor: string, sessionFile = `/tmp/${teamName}-${actor}.jsonl`) {
  return {
    sessionManager: {
      getSessionFile: () => sessionFile,
      buildContextEntries: () => [],
    },
    ui: { setStatus: vi.fn(), notify: vi.fn(), setTitle: vi.fn() },
  };
}

function fileBytesOrAbsent(file: string): Buffer | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const name of testTeams.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
  for (const root of testRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(spawnSync("bd", ["--version"], { stdio: "ignore" }).status !== 0)("Worker task_update TaskVersionRef boundary", () => {
  it("preserves opaque Task versions across graph-native Worker reads and claims", async () => {
    const teamName = uniqueTeam();
    const root = workspace();
    writeTeam(teamName, root);
    const lead = harness(teamName, "team-lead");
    const worker = harness(teamName, "worker");
    const leadCtx = context(teamName, "team-lead");
    const workerCtx = context(teamName, "worker");
    const create = lead.get("task_graph_apply")!;
    const update = worker.get("task_update")!;
    const read = worker.get("task_read")!;

    expect(Check(update.parameters as any, {
      task_id: "task-1",
      operation_id: "claim-version-safe",
      transition: "claim",
      expected_version: taskVersionRef("beads_v1"),
    })).toBe(true);
    expect(Check(update.parameters as any, {
      task_id: "task-1",
      operation_id: "context-version-safe",
      current_context: "Current meaning.",
      expected_version: taskVersionRef("beads_v1"),
    })).toBe(true);
    expect(Check(update.parameters as any, {
      task_id: "task-1",
      operation_id: "no-op-version-safe",
      expected_version: taskVersionRef("beads_v1"),
    })).toBe(false);
    expect(Check(update.parameters as any, {
      team_name: teamName,
      task_id: "task-1",
      operation_id: "unexpected-team",
      transition: "claim",
      expected_version: taskVersionRef("beads_v1"),
    })).toBe(false);

    const created = await create.execute("create", {
      operation_id: "create-version-safe-mutation",
      tasks: [{ key: "mutation", title: "Version-safe mutation", goal: "Prove Worker CAS version conversion.", assignee: "worker" }],
    }, undefined, undefined, leadCtx);
    const task = created.details.tasks_by_key.mutation;
    const readResult = await read.execute("read", { task_id: task.id }, undefined, undefined, workerCtx);
    const modelVersion = JSON.parse(readResult.content[0].text).task.version;
    expect(modelVersion).toBe(task.version);
    expect(modelVersion).toMatch(/^v_[0-9a-f]{16}$/);

    const claimed = await update.execute("claim", {
      task_id: task.id,
      operation_id: "worker-claim",
      transition: "claim",
      expected_version: modelVersion,
    }, undefined, undefined, workerCtx);
    expect(claimed.details).toMatchObject({
      kind: "updated",
      transition: "claim",
      task: { id: task.id, status: "in_progress" },
    });
    expect(claimed.details.task.version).toMatch(/^v_[0-9a-f]{16}$/);
    expect(claimed.details.task.version).not.toBe(modelVersion);
  }, 120_000);

  it("does not republish an idempotent create replay", async () => {
    const teamName = uniqueTeam();
    const root = workspace();
    writeTeam(teamName, root);
    let failPostCreateRead = true;
    const adapter = new BeadsTaskAdapter(teamName, "team-lead", {
      mode: "publishing",
      readMany: (taskIds) => taskAuthorityRead.readTaskAuthorityRecordEnvelopes(teamName, taskIds),
      list: () => taskAuthorityRead.listTaskIds(teamName),
      update: async () => { throw new Error("unused update"); },
      link: async () => { throw new Error("unused link"); },
      create: async (input, publication) => {
        const receipt = await createTask(teamName, input, publicationPort, { actor: "team-lead" }, publication, taskAuthorityTeamPort);
        return { ...receipt, taskCard: undefined };
      },
      read: async (taskId) => {
        if (failPostCreateRead) {
          failPostCreateRead = false;
          throw new Error("injected post-create read fault");
        }
        return taskAuthorityRead.readTaskAuthorityRecordEnvelope(teamName, taskId);
      },
    });
    const input = {
      operationId: "durable-create-replay",
      title: "Durable create replay",
      goal: "Keep one publication across a replay.",
      assignee: "worker",
    };

    expect(await adapter.create(input)).toMatchObject({ kind: "unknown_outcome", operationId: input.operationId });
    const replay = await adapter.create(input);
    expect(replay).toMatchObject({ kind: "created", operationId: input.operationId, task: { title: input.title, assignee: "worker" } });
    expect(await adapter.create({ ...input, title: "Changed title must conflict." })).toMatchObject({
      kind: "operation_conflict",
      operationId: input.operationId,
    });
    expect(await adapter.create({ ...input, goal: "Changed goal must conflict." })).toMatchObject({
      kind: "operation_conflict",
      operationId: input.operationId,
    });
    expect(await adapter.create({ ...input, assignee: undefined })).toMatchObject({
      kind: "operation_conflict",
      operationId: input.operationId,
    });

    expect(await tasks.listTasks(teamName, taskReadFactory)).toHaveLength(1);
    expect(readTeamEvents(teamName).events).toHaveLength(1);
    expect(await readTaskDeliveries(teamName, "worker")).toHaveLength(1);
  }, 60_000);

  it("routes real-Beads mutations through the injected Team port and retains no-port compatibility", async () => {
    const teamName = uniqueTeam();
    const root = workspace();
    const config = writeTeam(teamName, root);
    const calls: string[] = [];
    let actorInput: { teamName: string; actor: string; sessionFile: string; membershipId?: string } | undefined;
    const binding = {
      teamName,
      workspace: root,
      authorityFingerprint: config.taskAuthorityFingerprint!,
    };
    const port: TaskAuthorityTeamPort = {
      async binding(requestedTeamName) {
        calls.push(`binding:${requestedTeamName}`);
        return binding;
      },
      async withCurrentActor(input, action) {
        actorInput = input;
        calls.push(`actor:${input.actor}:enter`);
        const result = await action(binding);
        calls.push(`actor:${input.actor}:release`);
        return result;
      },
    };
    const factory = createPublishingBeadsTaskAdapterFactory(publicationPort, port, taskAuthorityRead);
    const leader = factory(teamName, "team-lead");
    const worker = factory(teamName, "worker");

    const created = await leader.create({
      operationId: "port-create",
      title: "Port-routed Task",
      goal: "Keep authority binding outside Task implementation.",
      assignee: "worker",
    });
    expect(created).toMatchObject({ kind: "created", task: { status: "open", assignee: "worker" } });
    if (created.kind !== "created") throw new Error("Expected a created Task.");
    expect(calls).toEqual([`binding:${teamName}`]);
    calls.length = 0;

    const updated = await worker.update({
      taskId: created.task.id,
      operationId: "port-update",
      expectedVersion: created.task.version as TaskVersionRef,
      status: "in_progress",
    });
    expect(updated).toMatchObject({ kind: "updated", task: { id: created.task.id, status: "in_progress" } });
    if (updated.kind !== "updated") throw new Error("Expected an updated Task.");
    expect(calls).toEqual([`binding:${teamName}`]);
    expect(readTeamEvents(teamName).events).toHaveLength(2);
    expect(await readTaskDeliveries(teamName, "worker")).toHaveLength(2);

    const target = await leader.create({
      operationId: "port-link-target",
      title: "Link target",
      goal: "Provide a real Beads relation target.",
    });
    if (target.kind !== "created") throw new Error("Expected a link target.");
    calls.length = 0;
    const originalLink = BeadsTaskStore.prototype.mutateLinkWithResult;
    vi.spyOn(BeadsTaskStore.prototype, "mutateLinkWithResult").mockImplementation(async function(this: BeadsTaskStore, ...args) {
      calls.push("backend:link");
      return originalLink.call(this, ...args);
    });
    const linkPublish = vi.spyOn(DurableTaskMutationPublication.prototype, "publishTaskMutation").mockImplementation(async function(this: DurableTaskMutationPublication, input) {
      calls.push(`publish:${input.kind}`);
      return { warnings: [], evidence: { teamEvent: { appended: true }, delivery: { attemptedRecipients: [], failedRecipients: [], recoveryRecordedFor: [], recoveryRecordFailedFor: [] } } };
    });
    const linked = await leader.link({
      taskId: created.task.id,
      targetId: target.task.id,
      relation: "related",
      action: "add",
      expectedVersion: updated.task.version as TaskVersionRef,
    }, {
      actingSessionFile: `/tmp/${teamName}-team-lead.jsonl`,
      actingMembershipId: config.members[0].membershipId,
    });
    expect(linked).toMatchObject({ kind: "linked", taskId: created.task.id, targetId: target.task.id, relation: "related", action: "add", changed: true });
    expect(actorInput).toEqual({
      teamName,
      actor: "team-lead",
      sessionFile: `/tmp/${teamName}-team-lead.jsonl`,
      membershipId: config.members[0].membershipId,
    });
    expect(calls).toEqual(["actor:team-lead:enter", "backend:link", "actor:team-lead:release", "publish:relation_changed"]);
    linkPublish.mockRestore();

    const compatibilityTeam = uniqueTeam();
    const compatibilityRoot = workspace();
    writeTeam(compatibilityTeam, compatibilityRoot);
    const compatibilityFactory = createPublishingBeadsTaskAdapterFactory(publicationPort, taskAuthorityTeamPort, taskAuthorityRead);
    const compatibilityLeader = compatibilityFactory(compatibilityTeam, "team-lead");
    const compatibilityWorker = compatibilityFactory(compatibilityTeam, "worker");
    const compatibilityCreated = await compatibilityLeader.create({
      operationId: "port-create",
      title: "Port-routed Task",
      goal: "Keep authority binding outside Task implementation.",
      assignee: "worker",
    });
    if (compatibilityCreated.kind !== "created") throw new Error("Expected a compatibility Task.");
    const compatibilityUpdated = await compatibilityWorker.update({
      taskId: compatibilityCreated.task.id,
      operationId: "port-update",
      expectedVersion: compatibilityCreated.task.version as TaskVersionRef,
      status: "in_progress",
    });
    expect(compatibilityCreated).toMatchObject({ kind: created.kind, task: { title: created.task.title, status: created.task.status, assignee: created.task.assignee, current_context: created.task.current_context } });
    expect(compatibilityUpdated).toMatchObject({ kind: updated.kind, task: { status: updated.task.status, assignee: updated.task.assignee, current_context: updated.task.current_context } });
    expect(readTeamEvents(compatibilityTeam).events.map((event) => event.type)).toEqual(["task", "task"]);
    expect(await readTaskDeliveries(compatibilityTeam, "worker")).toHaveLength(2);
  }, 120_000);

  it("bridges graph-native Worker transitions to assigned pre-graph Beads Tasks, then yields to graph authority", async () => {
    const teamName = uniqueTeam();
    const root = workspace();
    const config = writeTeam(teamName, root);
    config.logicalWorkers = [...(config.logicalWorkers ?? []), { name: "other", scope: "prove replay does not transfer Task ownership" }];
    config.members.push(member(teamName, "other", "teammate"));
    teams.writeConfigAtomic(paths.configPath(teamName), config);
    const lead = harness(teamName, "team-lead");
    const worker = harness(teamName, "worker");
    const other = harness(teamName, "other");
    const workerCtx = context(teamName, "worker");
    const otherCtx = context(teamName, "other");
    const leadCtx = context(teamName, "team-lead");
    const update = worker.get("task_update")!;
    const otherUpdate = other.get("task_update")!;
    const graphApply = lead.get("task_graph_apply")!;
    // This is the durable write path used by a resumed pre-graph leader's
    // legacy task_create surface.
    const legacyLead = createPublishingBeadsTaskAdapterFactory(
      publicationPort,
      taskAuthorityTeamPort,
      taskAuthorityRead,
    )(teamName, "team-lead");
    let operation = 0;
    const createLegacy = async (title: string, assignee = "worker") => {
      const created = await legacyLead.create({
        operationId: `legacy-create-${++operation}`,
        title,
        goal: `Complete ${title}.`,
        assignee,
      });
      if (created.kind !== "created") throw new Error(`Could not create legacy Task: ${created.message ?? created.kind}`);
      return created.task;
    };
    const workerTransition = (parameters: Record<string, unknown>) => update.execute(
      `worker-${++operation}`,
      parameters,
      undefined,
      undefined,
      workerCtx,
    );

    const claimedTask = await createLegacy("Claim and replay legacy Task");
    const claimed = await workerTransition({
      task_id: claimedTask.id,
      operation_id: "legacy-claim",
      expected_version: claimedTask.version,
      transition: "claim",
    });
    expect(claimed.details).toMatchObject({
      kind: "updated",
      transition: "claim",
      replayed: false,
      task: { id: claimedTask.id, status: "in_progress", assignee: "worker" },
    });
    const claimReplay = await workerTransition({
      task_id: claimedTask.id,
      operation_id: "legacy-claim",
      expected_version: claimedTask.version,
      transition: "claim",
    });
    expect(claimReplay.details).toMatchObject({
      kind: "updated",
      transition: "claim",
      replayed: true,
      task: { id: claimedTask.id, status: "in_progress" },
    });
    const otherReplay = await otherUpdate.execute("other-replay", {
      task_id: claimedTask.id,
      operation_id: "legacy-claim",
      expected_version: claimedTask.version,
      transition: "claim",
    }, undefined, undefined, otherCtx);
    expect(otherReplay.details).toMatchObject({
      kind: "refused",
      reason: "worker_mismatch",
      task_id: claimedTask.id,
      current_task: { assignee: "worker", status: "in_progress" },
      state_changed: false,
    });
    const stale = await workerTransition({
      task_id: claimedTask.id,
      operation_id: "legacy-stale-block",
      expected_version: claimedTask.version,
      transition: "block",
      evidence: "This must refuse before a stale write.",
    });
    expect(stale.details).toMatchObject({
      kind: "refused",
      reason: "version_conflict",
      task_id: claimedTask.id,
      state_changed: false,
    });

    const succeeded = await workerTransition({
      task_id: claimedTask.id,
      operation_id: "legacy-goal-achieved",
      expected_version: claimed.details.task.version,
      transition: "goal_achieved",
      evidence: "The legacy Task goal passed its external check.",
    });
    expect(succeeded.details).toMatchObject({
      kind: "updated",
      transition: "goal_achieved",
      task: { id: claimedTask.id, status: "closed" },
    });

    const unsafeTask = await createLegacy("Refuse unsafe legacy outcomes");
    const unsafeClaim = await workerTransition({
      task_id: unsafeTask.id,
      operation_id: "legacy-unsafe-claim",
      expected_version: unsafeTask.version,
      transition: "claim",
      current_context: "Worker started the legacy Task through the claim path.",
    });
    expect(unsafeClaim.details).toMatchObject({
      kind: "updated",
      transition: "claim",
      task: {
        id: unsafeTask.id,
        status: "in_progress",
        current_context: "Worker started the legacy Task through the claim path.",
      },
    });
    const failed = await workerTransition({
      task_id: unsafeTask.id,
      operation_id: "legacy-goal-failed",
      expected_version: unsafeClaim.details.task.version,
      transition: "goal_failed",
      evidence: "The criterion did not pass.",
    });
    expect(failed.details).toMatchObject({
      kind: "refused",
      reason: "legacy_transition_unsupported",
      task_id: unsafeTask.id,
      state_changed: false,
    });
    const cancelled = await workerTransition({
      task_id: unsafeTask.id,
      operation_id: "legacy-cancel",
      expected_version: unsafeClaim.details.task.version,
      transition: "cancel",
      evidence: "Stop this legacy Task.",
    });
    expect(cancelled.details).toMatchObject({
      kind: "refused",
      reason: "legacy_transition_unsupported",
      task_id: unsafeTask.id,
      state_changed: false,
    });
    const blocked = await workerTransition({
      task_id: unsafeTask.id,
      operation_id: "legacy-block",
      expected_version: unsafeClaim.details.task.version,
      transition: "block",
      evidence: "An external dependency is unavailable.",
    });
    expect(blocked.details).toMatchObject({
      kind: "updated",
      transition: "block",
      task: { id: unsafeTask.id, status: "blocked" },
    });

    const blocker = await createLegacy("Legacy prerequisite");
    const waitingTask = await createLegacy("Legacy dependent");
    const linked = await legacyLead.link({
      taskId: waitingTask.id,
      targetId: blocker.id,
      relation: "blocked_by",
      action: "add",
      expectedVersion: waitingTask.version as TaskVersionRef,
    });
    if (linked.kind !== "linked") throw new Error(`Could not create legacy dependency: ${linked.message}`);
    const waiting = await workerTransition({
      task_id: waitingTask.id,
      operation_id: "legacy-waiting-claim",
      expected_version: linked.version,
      transition: "claim",
    });
    expect(waiting.details).toMatchObject({
      kind: "refused",
      reason: "invalid_transition",
      task_id: waitingTask.id,
      current_task: {
        status: "open",
        dependency_state: { kind: "waiting", active_blocker_ids: [blocker.id] },
      },
      state_changed: false,
    });
    expect(waiting.details.message).toMatch(/dependency waiting.*not blocked/i);

    const graph = await graphApply.execute("graph-switch", {
      operation_id: "switch-to-graph",
      tasks: [{
        key: "graph-task",
        title: "Graph Task",
        goal: "Prove graph authority wins after its first revision.",
        assignee: "worker",
      }],
    }, undefined, undefined, leadCtx);
    expect(graph.details).toMatchObject({ kind: "task_graph_applied" });
    const afterSwitch = await workerTransition({
      task_id: waitingTask.id,
      operation_id: "legacy-after-switch",
      expected_version: linked.version,
      transition: "claim",
    });
    expect(afterSwitch.details).toMatchObject({
      kind: "refused",
      reason: "task_not_found",
      task_id: waitingTask.id,
      state_changed: false,
    });
    await expect(legacyLead.read(waitingTask.id)).resolves.toMatchObject({ kind: "found", task: { status: "open" } });
  }, 120_000);


});
