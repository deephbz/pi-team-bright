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
import * as teams from "./teams";
import { MODEL_TOOL_IMPLEMENTATION_VERSION } from "../model-tool-contract/model-tool-constants";
import { CandidateBeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import { readTaskDeliveries } from "./task-delivery";
import { readTeamEvents } from "./team-events";

type Tool = { name: string; parameters: unknown; execute: (...args: any[]) => Promise<any> };

const testTeams: string[] = [];
const testRoots: string[] = [];

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
    implementationVersion: MODEL_TOOL_IMPLEMENTATION_VERSION,
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

function context(teamName: string, actor: string) {
  return {
    sessionManager: {
      getSessionFile: () => `/tmp/${teamName}-${actor}.jsonl`,
      buildContextEntries: () => [],
    },
    ui: { setStatus: vi.fn(), notify: vi.fn(), setTitle: vi.fn() },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const name of testTeams.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
  for (const root of testRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(spawnSync("bd", ["--version"], { stdio: "ignore" }).status !== 0)("Worker task_update TaskVersionRef boundary", () => {
  it("requires opaque refs, resolves them to raw CAS versions, and returns current refs for reconcile", async () => {
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
      team_name: teamName,
      task_id: "task-1",
      status: "in_progress",
      expected_version: taskVersionRef("beads_v1"),
    })).toBe(true);
    expect(Check(update.parameters as any, { team_name: teamName, task_id: "task-1", status: "in_progress" })).toBe(false);
    expect(Check(update.parameters as any, { team_name: teamName, task_id: "task-1", status: "in_progress", expected_version: "beads_v1" })).toBe(false);

    const created = await create.execute("create", {
      tasks: [{ operation_id: "create-version-safe-mutation", title: "Version-safe mutation", goal: "Prove Worker CAS version conversion.", assignee: "worker" }],
    }, undefined, undefined, leadCtx);
    const task = created.details.outcomes[0].task;
    const readResult = await read.execute("read", { team_name: teamName, task_id: task.id }, undefined, undefined, workerCtx);
    const modelVersion = JSON.parse(readResult.content[0].text).task.version;
    expect(modelVersion).toBe(taskVersionRef(task.version));

    const originalApply = tasks.applySemanticTaskUpdate;
    const expectedVersions: string[] = [];
    vi.spyOn(tasks, "applySemanticTaskUpdate").mockImplementation(async (...args: any[]) => {
      expectedVersions.push(args[3].expectedVersion);
      return originalApply(...args as Parameters<typeof tasks.applySemanticTaskUpdate>);
    });
    const updated = await update.execute("first", {
      team_name: teamName,
      task_id: task.id,
      status: "in_progress",
      expected_version: modelVersion,
    }, undefined, undefined, workerCtx);
    expect(expectedVersions).toEqual([task.version]);
    expect(updated.details).toMatchObject({
      kind: "task_update_batch",
      outcomes: [{ kind: "updated", task_id: task.id, task: { status: "in_progress" } }],
    });
    const updatedRaw = updated.details.outcomes[0].task.version;
    expect(JSON.parse(updated.content[0].text)).toMatchObject({ kind: "updated", task: { version: taskVersionRef(updatedRaw) } });

    const noVersion = await update.execute("no-version", {
      team_name: teamName,
      task_id: task.id,
      append_note: "This must not bypass CAS.",
    }, undefined, undefined, workerCtx);
    expect(noVersion.details).toMatchObject({
      kind: "task_update_batch",
      outcomes: [{ kind: "refused", reason: "version_conflict", current_task: { id: task.id, version: updatedRaw }, state_changed: false }],
    });
    expect(JSON.parse(noVersion.content[0].text)).toMatchObject({
      kind: "refused",
      reason: "version_conflict",
      current_task: { version: taskVersionRef(updatedRaw) },
      recovery: { action: "reconcile_and_retry", expected_version: taskVersionRef(updatedRaw) },
    });

    const rawVersion = await update.execute("raw-version", {
      team_name: teamName,
      task_id: task.id,
      append_note: "Raw authority versions are not model input.",
      expected_version: updatedRaw,
    }, undefined, undefined, workerCtx);
    expect(rawVersion.details.outcomes[0]).toMatchObject({ kind: "refused", reason: "version_conflict", current_task: { version: updatedRaw }, state_changed: false });

    const appended = await update.execute("append", {
      team_name: teamName,
      task_id: task.id,
      append_note: "Append-note-only Worker mutations remain valid.",
      expected_version: taskVersionRef(updatedRaw),
    }, undefined, undefined, workerCtx);
    expect(appended.details.outcomes[0]).toMatchObject({ kind: "updated", task: { status: "in_progress" } });

    const claimCreated = await create.execute("create-claim", {
      tasks: [{ operation_id: "create-version-safe-claim", title: "Version-safe claim", goal: "Prove claim uses the same version boundary." }],
    }, undefined, undefined, leadCtx);
    const claimTask = claimCreated.details.outcomes[0].task;
    const claimVersion = JSON.parse((await read.execute("read-claim", {
      team_name: teamName,
      task_id: claimTask.id,
    }, undefined, undefined, workerCtx)).content[0].text).task.version;
    const claimed = await update.execute("claim", {
      team_name: teamName,
      task_id: claimTask.id,
      claim: true,
      expected_version: claimVersion,
    }, undefined, undefined, workerCtx);
    expect(claimed.details.outcomes[0]).toMatchObject({
      kind: "updated",
      task: { id: claimTask.id, status: "in_progress", assignee: "worker" },
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
    const adapter = new CandidateBeadsTaskAdapter(teamName, "team-lead", {
      create: (input, publication) => tasks.createTask(teamName, input, { actor: "team-lead" }, publication),
      read: async (taskId) => {
        if (failPostCreateRead) {
          failPostCreateRead = false;
          throw new Error("injected post-create read fault");
        }
        return tasks.readCandidateTaskAuthorityRecord(teamName, taskId);
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
    const visibleVersion = JSON.parse((await worker.get("task_read")!.execute("read", { team_name: teamName, task_id: task.id }, undefined, undefined, workerCtx)).content[0].text).task.version;
    const store = new BeadsTaskStore({ teamName, workspace: root, authorityFingerprint: config.taskAuthorityFingerprint!, requireExpectedVersion: true });
    const originalRead = tasks.readCandidateTaskAuthorityRecord;
    vi.spyOn(tasks, "readCandidateTaskAuthorityRecord").mockImplementationOnce(async (...args: any[]) => {
      const record = await originalRead(...args as Parameters<typeof tasks.readCandidateTaskAuthorityRecord>);
      await store.update(record.task.id, { description: "External writer won the race." }, { actor: "team-lead", expectedVersion: record.task.version });
      return record;
    });

    const raced = await worker.get("task_update")!.execute("raced", {
      team_name: teamName,
      task_id: task.id,
      append_note: "This write must lose the raw preflight race.",
      expected_version: visibleVersion,
    }, undefined, undefined, workerCtx);
    const current = await tasks.readTask(teamName, task.id);
    expect(raced.details.outcomes[0]).toMatchObject({ kind: "refused", reason: "version_conflict", current_task: { id: task.id, version: current.version }, state_changed: false });
    expect(JSON.parse(raced.content[0].text)).toMatchObject({ recovery: { action: "reconcile_and_retry", expected_version: taskVersionRef(current.version) } });
  }, 60_000);
});
