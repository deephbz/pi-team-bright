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

type Tool = { name: string; parameters: unknown; execute: (...args: any[]) => Promise<any> };

const testTeams: string[] = [];
const testRoots: string[] = [];
const publicationPort = new DurableTaskMutationPublication();

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

function harness(teamName: string, actor: "team-lead" | "worker"): Map<string, Tool> {
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
  it("accepts historical package provenance and preserves opaque Task version reconciliation", async () => {
    const teamName = uniqueTeam();
    const root = workspace();
    writeTeam(teamName, root);
    const lead = harness(teamName, "team-lead");
    const worker = harness(teamName, "worker");
    const leadCtx = context(teamName, "team-lead");
    const workerCtx = context(teamName, "worker");
    const create = lead.get("task_create")!;
    const update = worker.get("task_update")!;
    const read = worker.get("task_read")!;

    expect(Check(update.parameters as any, {
      task_id: "task-1",
      operation_id: "update-version-safe",
      status: "in_progress",
      expected_version: taskVersionRef("beads_v1"),
    })).toBe(true);
    expect(Check(update.parameters as any, {
      task_id: "task-1",
      operation_id: "claim-version-safe",
      claim: true,
      expected_version: taskVersionRef("beads_v1"),
    })).toBe(true);
    // The former team_name coordinate is gone, but the three unchanged
    // required coordinates still accept a no-op update at the schema boundary.
    expect(Check(update.parameters as any, {
      task_id: "task-1",
      operation_id: "no-op-version-safe",
      expected_version: taskVersionRef("beads_v1"),
    })).toBe(true);
    expect(Check(update.parameters as any, {
      task_id: "task-1",
      claim: true,
      status: "in_progress",
      expected_version: taskVersionRef("beads_v1"),
    })).toBe(false);
    expect(Check(update.parameters as any, { task_id: "task-1", status: "in_progress" })).toBe(false);
    expect(Check(update.parameters as any, { task_id: "task-1", status: "in_progress", expected_version: "beads_v1" })).toBe(false);
    expect(Check(update.parameters as any, { team_name: teamName, task_id: "task-1", operation_id: "unexpected-team", status: "in_progress", expected_version: taskVersionRef("beads_v1") })).toBe(false);

    const created = await create.execute("create", {
      tasks: [{ operation_id: "create-version-safe-mutation", title: "Version-safe mutation", goal: "Prove Worker CAS version conversion.", assignee: "worker" }],
    }, undefined, undefined, leadCtx);
    const task = created.details.outcomes[0].task;
    const readResult = await read.execute("read", { task_id: task.id }, undefined, undefined, workerCtx);
    const modelVersion = JSON.parse(readResult.content[0].text).task.version;
    expect(modelVersion).toBe(task.version);

    const originalApply = authority.applySemanticTaskUpdate;
    const expectedVersions: string[] = [];
    vi.spyOn(authority, "applySemanticTaskUpdate").mockImplementation(async (...args: any[]) => {
      expectedVersions.push(args[3].expectedVersion);
      return originalApply(...args as Parameters<typeof authority.applySemanticTaskUpdate>);
    });
    const updated = await update.execute("first", {
      task_id: task.id,
      operation_id: "worker-first-update",
      status: "in_progress",
      expected_version: modelVersion,
    }, undefined, undefined, workerCtx);
    expect(expectedVersions).toEqual([expect.stringMatching(/^beads_[0-9a-f]{64}$/)]);
    expect(updated.details).toMatchObject({
      kind: "task_update_batch",
      outcomes: [{ kind: "updated", task_id: task.id, task: { status: "in_progress" } }],
    });
    const updatedRaw = updated.details.outcomes[0].task.version;
    expect(JSON.parse(updated.content[0].text)).toMatchObject({ kind: "updated", task: { version: updatedRaw } });

    const noVersion = await update.execute("no-version", {
      task_id: task.id,
      operation_id: "worker-no-version",
      append_note: "This must not bypass CAS.",
    }, undefined, undefined, workerCtx);
    expect(noVersion.details).toMatchObject({
      kind: "task_update_batch",
      outcomes: [{ kind: "refused", reason: "version_conflict", current_task: { id: task.id, version: updatedRaw }, state_changed: false }],
    });
    expect(JSON.parse(noVersion.content[0].text)).toMatchObject({
      kind: "refused",
      reason: "version_conflict",
      current_task: { version: updatedRaw },
      recovery: { action: "reconcile_and_retry", expected_version: updatedRaw },
    });

    const rawVersion = await update.execute("raw-version", {
      task_id: task.id,
      operation_id: "worker-raw-version",
      append_note: "Raw authority versions are not model input.",
      expected_version: "beads_raw_version",
    }, undefined, undefined, workerCtx);
    expect(rawVersion.details.outcomes[0]).toMatchObject({ kind: "refused", reason: "version_conflict", current_task: { version: updatedRaw }, state_changed: false });

    const appended = await update.execute("append", {
      task_id: task.id,
      operation_id: "worker-append",
      append_note: "Append-note-only Worker mutations remain valid.",
      expected_version: updatedRaw,
    }, undefined, undefined, workerCtx);
    expect(appended.details.outcomes[0]).toMatchObject({ kind: "updated", task: { status: "in_progress" } });

    const claimCreated = await create.execute("create-claim", {
      tasks: [{ operation_id: "create-version-safe-claim", title: "Version-safe claim", goal: "Prove claim uses the same version boundary." }],
    }, undefined, undefined, leadCtx);
    const claimTask = claimCreated.details.outcomes[0].task;
    const claimVersion = JSON.parse((await read.execute("read-claim", {
      task_id: claimTask.id,
    }, undefined, undefined, workerCtx)).content[0].text).task.version;
    const claimed = await update.execute("status", {
      task_id: claimTask.id,
      operation_id: "worker-claim-status",
      status: "in_progress",
      expected_version: claimVersion,
    }, undefined, undefined, workerCtx);
    expect(claimed.details.outcomes[0]).toMatchObject({
      kind: "updated",
      task: { id: claimTask.id, status: "in_progress" },
    });
  // This scenario makes several serial real-Beads mutations and reads. It normally
  // completes in 28 seconds, but aggregate workers can contend on the Beads
  // process/database startup path. Keep a bounded timeout that detects a lock
  // failure without rejecting that measured aggregate-only contention.
  }, 120_000);

  it("does not republish an idempotent create replay", async () => {
    const teamName = uniqueTeam();
    const root = workspace();
    writeTeam(teamName, root);
    let failPostCreateRead = true;
    const adapter = new BeadsTaskAdapter(teamName, "team-lead", {
      create: async (input, publication) => {
        const receipt = await createTask(teamName, input, publicationPort, { actor: "team-lead" }, publication);
        return { ...receipt, taskCard: undefined };
      },
      read: async (taskId) => {
        if (failPostCreateRead) {
          failPostCreateRead = false;
          throw new Error("injected post-create read fault");
        }
        return authority.readTaskAuthorityRecordEnvelope(teamName, taskId);
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

    expect(await tasks.listTasks(teamName)).toHaveLength(1);
    expect(readTeamEvents(teamName).events).toHaveLength(1);
    expect(await readTaskDeliveries(teamName, "worker")).toHaveLength(1);
  }, 60_000);

  it("uses one Task authority read through the Worker adapter", async () => {
    const teamName = uniqueTeam();
    const root = workspace();
    writeTeam(teamName, root);
    const lead = harness(teamName, "team-lead");
    const worker = harness(teamName, "worker");
    const leadCtx = context(teamName, "team-lead");
    const workerCtx = context(teamName, "worker");
    const created = await lead.get("task_create")!.execute("create", {
      tasks: [{ operation_id: "create-worker-read", title: "Worker read", goal: "Read one exact Task authority record.", assignee: "worker" }],
    }, undefined, undefined, leadCtx);
    const task = created.details.outcomes[0].task;
    const taskAuthorityRead = vi.spyOn(authority, "readTaskAuthorityRecordEnvelope");
    const genericRead = vi.spyOn(tasks, "readTask");

    const result = await worker.get("task_read")!.execute("read", {
      task_id: task.id,
    }, undefined, undefined, workerCtx);

    expect(taskAuthorityRead).toHaveBeenCalledOnce();
    expect(taskAuthorityRead).toHaveBeenCalledWith(teamName, task.id);
    expect(genericRead).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ kind: "found", task: { id: task.id, version: expect.any(String) } });
  }, 60_000);

  it("refuses a replaced Worker before authority mutation, then lets its replacement mutate", async () => {
    const teamName = uniqueTeam();
    const root = workspace();
    writeTeam(teamName, root);
    const lead = harness(teamName, "team-lead");
    const worker = harness(teamName, "worker");
    const leadCtx = context(teamName, "team-lead");
    const staleSessionFile = `/tmp/${teamName}-worker.jsonl`;
    const staleWorkerCtx = context(teamName, "worker", staleSessionFile);
    const created = await lead.get("task_create")!.execute("create", {
      tasks: [{ operation_id: "create-stale-actor", title: "Stale actor", goal: "Record current stale Worker mutation behavior.", assignee: "worker" }],
    }, undefined, undefined, leadCtx);
    const task = created.details.outcomes[0].task;
    const beforeAuthority = structuredClone(await authority.readTaskAuthorityRecordEnvelope(teamName, task.id));
    const beforeCanonicalTask = structuredClone(await new BeadsTaskAdapter(teamName, "worker").read(task.id));
    const beforeOperationMetadata = structuredClone(beforeAuthority.taskMetadata);
    const beforeEvents = readTeamEvents(teamName).events;
    const beforeDeliveries = await readTaskDeliveries(teamName, "worker");
    const hintPath = paths.taskEventFailureHintPath(teamName);
    const beforeHints = fileBytesOrAbsent(hintPath);
    const updateCalls = vi.spyOn(BeadsTaskStore.prototype, "updateWithResult");
    const suppress = vi.spyOn(DurableTaskMutationPublication.prototype, "suppressTaskVersionForSession");
    const publish = vi.spyOn(DurableTaskMutationPublication.prototype, "publishTaskMutation");
    const complete = vi.spyOn(DurableTaskMutationPublication.prototype, "completeOwnerTransitionIntent");
    const originalApply = authority.applySemanticTaskUpdate;
    const staleMembership = await teams.currentMembership(teamName, "worker");
    const replacementSessionFile = `/tmp/${teamName}-worker-replacement.jsonl`;
    let replacementMembershipId: string | undefined;
    vi.spyOn(authority, "applySemanticTaskUpdate").mockImplementationOnce(async (...args: any[]) => {
      await teams.deactivateMembership(teamName, staleMembership.membershipId!, "replaced");
      const replacement = member(teamName, "worker", "teammate");
      replacement.membershipId = teams.newMembershipId();
      replacement.agentId = `replacement@${teamName}`;
      replacement.sessionFile = replacementSessionFile;
      replacementMembershipId = replacement.membershipId;
      await teams.addMember(teamName, replacement);
      return originalApply(...args as Parameters<typeof authority.applySemanticTaskUpdate>);
    });

    await expect(worker.get("task_update")!.execute("stale-update", {
      task_id: task.id,
      operation_id: "stale-actor-update",
      status: "in_progress",
      expected_version: task.version,
    }, undefined, undefined, staleWorkerCtx)).rejects.toThrow(
      `Membership ${staleMembership.membershipId} / Session ${staleSessionFile} is not the current binding for worker on team ${teamName}; stale processes cannot mutate authority state.`,
    );
    expect(updateCalls).not.toHaveBeenCalled();
    expect(suppress).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(await authority.readTaskAuthorityRecordEnvelope(teamName, task.id)).toEqual(beforeAuthority);
    expect(await new BeadsTaskAdapter(teamName, "worker").read(task.id)).toEqual(beforeCanonicalTask);
    expect((await authority.readTaskAuthorityRecordEnvelope(teamName, task.id)).taskMetadata).toEqual(beforeOperationMetadata);
    expect(readTeamEvents(teamName).events).toEqual(beforeEvents);
    expect(fileBytesOrAbsent(hintPath)).toEqual(beforeHints);
    expect(await readTaskDeliveries(teamName, "worker")).toEqual(beforeDeliveries);

    const replacementWorker = harness(teamName, "worker");
    const replay = await replacementWorker.get("task_update")!.execute("replacement-first-update", {
      task_id: task.id,
      operation_id: "stale-actor-update",
      status: "in_progress",
      expected_version: task.version,
    }, undefined, undefined, context(teamName, "worker", replacementSessionFile));
    expect(replay.details.outcomes[0]).toMatchObject({
      kind: "updated",
      task_id: task.id,
      operation_id: "stale-actor-update",
      task: { status: "in_progress" },
    });
    expect(updateCalls).toHaveBeenCalledOnce();
    expect(suppress).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    const afterAuthority = await authority.readTaskAuthorityRecordEnvelope(teamName, task.id);
    expect(afterAuthority).not.toEqual(beforeAuthority);
    expect(afterAuthority.task).toMatchObject({ id: task.id, status: "in_progress" });
    expect(JSON.parse(String(afterAuthority.taskMetadata))).toMatchObject({ last_operation: { operation_id: "stale-actor-update" } });
    expect(readTeamEvents(teamName).events).toHaveLength(beforeEvents.length + 1);
    expect(fileBytesOrAbsent(hintPath)).toEqual(beforeHints);
    const afterDeliveries = await readTaskDeliveries(teamName, "worker");
    expect(afterDeliveries).toEqual([
      ...beforeDeliveries,
      expect.objectContaining({
        ref: { kind: "task", taskId: task.id, version: replay.details.outcomes[0].task.version },
        recipientMembershipId: replacementMembershipId,
        recipientSessionFile: replacementSessionFile,
      }),
    ]);
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
    const factory = createPublishingBeadsTaskAdapterFactory(publicationPort, port);
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
    const compatibilityFactory = createPublishingBeadsTaskAdapterFactory(publicationPort);
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

  it("keeps the raw conditional preflight after model-ref resolution", async () => {
    const teamName = uniqueTeam();
    const root = workspace();
    const config = writeTeam(teamName, root);
    const lead = harness(teamName, "team-lead");
    const worker = harness(teamName, "worker");
    const leadCtx = context(teamName, "team-lead");
    const workerCtx = context(teamName, "worker");
    const created = await lead.get("task_create")!.execute("create", {
      tasks: [{ operation_id: "create-race", title: "Race", goal: "Keep the post-resolution raw preflight.", assignee: "worker" }],
    }, undefined, undefined, leadCtx);
    const task = created.details.outcomes[0].task;
    const visibleVersion = JSON.parse((await worker.get("task_read")!.execute("read", { task_id: task.id }, undefined, undefined, workerCtx)).content[0].text).task.version;
    const store = new BeadsTaskStore({ teamName, workspace: root, authorityFingerprint: config.taskAuthorityFingerprint!, requireExpectedVersion: true });
    const originalRead = authority.readTaskAuthorityRecordEnvelope;
    vi.spyOn(authority, "readTaskAuthorityRecordEnvelope").mockImplementationOnce(async (...args: any[]) => {
      const record = await originalRead(...args as Parameters<typeof authority.readTaskAuthorityRecordEnvelope>);
      await store.update(record.task.id, { description: "External writer won the race." }, { actor: "team-lead", expectedVersion: record.task.version });
      return record;
    });

    const raced = await worker.get("task_update")!.execute("raced", {
      task_id: task.id,
      operation_id: "worker-raced-update",
      append_note: "This write must lose the raw preflight race.",
      expected_version: visibleVersion,
    }, undefined, undefined, workerCtx);
    const current = await tasks.readTask(teamName, task.id);
    expect(raced.details.outcomes[0]).toMatchObject({ kind: "refused", reason: "version_conflict", current_task: { id: task.id, version: current.version }, state_changed: false });
    expect(JSON.parse(raced.content[0].text)).toMatchObject({ recovery: { action: "reconcile_and_retry", expected_version: current.version } });
  }, 60_000);
});
