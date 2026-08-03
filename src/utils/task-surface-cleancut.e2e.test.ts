import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { BeadsTaskStore, readBeadsAuthorityFingerprint, type TaskWriteOptions } from "./beads";
import type { TeamConfig } from "./models";
import * as paths from "./paths";
import * as teams from "./teams";
import { MODEL_TOOL_IMPLEMENTATION_VERSION } from "../../src/model-tool-contract/preview-constants";
import { taskVersionRef } from "../../src/model-tool-contract/task-version-ref";

type RegisteredTool = {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<any>;
};

const hasBd = spawnSync("bd", ["--version"], { stdio: "ignore" }).status === 0;
const testTeams: string[] = [];
const testRoots: string[] = [];

vi.setConfig({ testTimeout: 300_000, hookTimeout: 180_000 });

function uniqueTeam(suffix: string): string {
  const name = `task-surface-${suffix}-${process.pid}-${Date.now()}-${testTeams.length}`;
  testTeams.push(name);
  return name;
}

function tempRoot(suffix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-teams-${suffix}-`));
  testRoots.push(root);
  return root;
}

function initBeadsWorkspace(): string {
  const workspace = path.join(tempRoot("task-surface-beads"), "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks"], {
    cwd: workspace,
    stdio: "ignore",
  });
  return workspace;
}

function writeTeam(name: string, workspace: string): TeamConfig {
  fs.mkdirSync(paths.teamDir(name), { recursive: true });
  const config: TeamConfig = {
    name,
    description: "clean-cut Task-surface E2E",
    createdAt: Date.now(),
    epochId: teams.newTeamEpochId(),
    leadAgentId: `lead@${name}`,
    leadSessionId: `/tmp/${name}-lead.jsonl`,
    taskBackend: "beads",
    taskWorkspace: workspace,
    taskAuthorityId: `task_authority_${crypto.randomUUID()}`,
    taskAuthorityFingerprint: readBeadsAuthorityFingerprint(workspace),
    implementationVersion: MODEL_TOOL_IMPLEMENTATION_VERSION,
    logicalWorkers: ["worker-a", "worker-b"].map((worker) => ({ name: worker, scope: "task-surface worker capability" })),
    members: ["team-lead", "worker-a", "worker-b"].map((member, index) => ({
      membershipId: `membership_${member}_${name}`,
      agentId: `${member}@${name}`,
      name: member,
      agentType: member === "team-lead" ? "lead" : "teammate",
      joinedAt: Date.now() + index,
      tmuxPaneId: "",
      cwd: process.cwd(),
      subscriptions: [],
      sessionFile: `/tmp/${name}-${member}.jsonl`,
      isActive: true,
    })),
  };
  teams.writeConfigAtomic(paths.configPath(name), config);
  return config;
}

function extensionHarness(actor = "team-lead", teamName?: string) {
  if (teamName) vi.stubEnv("PI_TEAM_NAME", teamName);
  else vi.stubEnv("PI_TEAM_NAME", "");
  vi.stubEnv("PI_AGENT_NAME", actor === "team-lead" ? "" : actor);
  vi.stubEnv("TMUX", "");
  const tools = new Map<string, RegisteredTool>();
  piTeams({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on() {},
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  } as never);
  if (actor === "team-lead") {
    for (const name of ["task_create", "task_update", "task_read", "task_link", "team_sync"]) {
      const tool = tools.get(name);
      if (!tool) continue;
      const originalExecute = tool.execute;
      tools.set(name, { ...tool, execute: async (id, params, signal, update, ctx) => {
        const args: any = { ...params };
        if (name === "task_create" && !args.tasks) {
          args.tasks = [{ title: args.title, goal: args.acceptance_criteria || args.description || "Complete the requested Task.", ...(args.assignee ? { assignee: args.assignee } : {}) }];
          for (const key of ["team_name", "title", "description", "acceptance_criteria", "assignee", "design", "idempotency_key"]) delete args[key];
        } else if (name === "task_update" && !args.updates) {
          args.updates = [{ task_id: args.task_id, operation_id: `cleancut-${id}`, expected_version: taskVersionRef(args.expected_version || ""), current_context: args.design || args.append_note || "Task evidence was reviewed.", journal_entries: [{ kind: "note", text: args.append_note || args.design || "Task evidence was reviewed." }], ...(args.status ? { status: args.status } : {}) }];
          for (const key of ["team_name", "task_id", "claim", "assignee", "description", "design", "append_note", "expected_version", "status", "title"]) delete args[key];
        } else if (name === "task_read" && args.task_id) {
          args.task_ids = [args.task_id]; delete args.task_id; delete args.team_name;
        } else if (name === "team_sync") {
          args.view = args.view || (args.cursor ? "updates" : "snapshot"); delete args.team_name; delete args.cursor; delete args.wait_ms; delete args.event_types; delete args.task_ids; delete args.limit; delete args.continuation;
        } else if (name === "task_link") {
          delete args.team_name;
          if (typeof args.expected_version === "string") args.expected_version = taskVersionRef(args.expected_version);
        }
        return originalExecute(id, args, signal, update, ctx);
      } });
    }
  }
  return tools;
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

function schemaKeys(tool: RegisteredTool | undefined): string[] {
  if (!tool) throw new Error("expected registered tool");
  return Object.keys(tool.parameters?.properties || {}).sort();
}

function taskFrom(result: any): Record<string, any> {
  const outcome = result?.details?.outcomes?.find((candidate: any) => candidate.task);
  const task = result?.details?.postState || outcome?.task || (result?.details?.kind === "task_linked"
    ? { id: result.details.task_id, relations: result.details.action === "add" ? [{ relation: result.details.relation, targetId: result.details.target_id }] : [], version: result.details.version }
    : undefined);
  if (!task || typeof task !== "object") throw new Error(`missing structured Task receipt: ${JSON.stringify(result)}`);
  const projected = task.goal ? { ...task, description: task.goal, acceptanceCriteria: task.goal, relations: task.relations || [] } : { ...task };
  if (task.current_context) projected.design = task.current_context;
  if (outcome?.journal_entries) projected.notes = outcome.journal_entries.map((entry: any) => entry.text).join("\n");
  else if (task.current_context) projected.notes = task.current_context;
  return projected;
}

function assertCurrentTaskShape(task: Record<string, any>): void {
  expect(task).toEqual(expect.objectContaining({
    id: expect.any(String),
    title: expect.any(String),
    description: expect.any(String),
    status: expect.stringMatching(/^(open|in_progress|blocked|closed)$/),
    relations: expect.any(Array),
    version: expect.any(String),
  }));
  for (const legacy of ["subject", "activeForm", "metadata", "owner", "plan", "planFeedback", "blocks", "blockedBy"]) {
    expect(task).not.toHaveProperty(legacy);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const name of testTeams.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
  for (const root of testRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("clean-cut Task public surface", () => {
  it("exports four stable Task verbs plus team_sync and no plan or legacy-schema escape hatches", () => {
    const tools = extensionHarness();
    expect([...tools.keys()].filter((name) => name.startsWith("task_")).sort()).toEqual([
      "task_create",
      "task_link",
      "task_read",
      "task_update",
    ]);
    expect(tools.has("team_sync")).toBe(true);

    expect(schemaKeys(tools.get("task_create"))).toEqual(["tasks"]);
    expect(schemaKeys(tools.get("task_update"))).toEqual(["updates"]);
    expect(schemaKeys(tools.get("task_link"))).toEqual(["action", "expected_version", "relation", "target_id", "task_id"]);

    const serialized = JSON.stringify([...tools.values()]
      .filter((tool) => tool.name.startsWith("task_"))
      .map((tool) => tool.parameters));
    for (const removed of [
      "active_form",
      "metadata",
      "plan",
      "plan_feedback",
      "planning",
      "pending_problem",
      "deleted",
    ]) expect(serialized).not.toContain(`\"${removed}\"`);
  });

  it("supports direct execution, prose design review, stale-write rejection, notes, claims, and graph relations", async () => {
    expect(hasBd, "The clean-cut E2E requires the sole Task authority CLI (`bd`) to be installed.").toBe(true);
    const teamName = uniqueTeam("workflow");
    const taskWorkspace = initBeadsWorkspace();
    writeTeam(teamName, taskWorkspace);
    const lead = extensionHarness("team-lead", teamName);
    const workerA = extensionHarness("worker-a", teamName);
    const workerB = extensionHarness("worker-b", teamName);
    const leadCtx = context(teamName, "team-lead");
    const workerACtx = context(teamName, "worker-a");
    const workerBCtx = context(teamName, "worker-b");

    const create = lead.get("task_create")!;
    const updateLead = lead.get("task_update")!;
    const updateA = workerA.get("task_update")!;
    const updateB = workerB.get("task_update")!;
    const read = lead.get("task_read")!;
    const link = lead.get("task_link")!;
    const sync = lead.get("team_sync")!;

    // Simple work skips review: atomic claim is the only safety-specialized mutation.
    const directResult = await create.execute("create-direct", {
      tasks: [{
        title: "Run deterministic checks",
        goal: "Execute the deterministic test command and confirm it exits successfully.",
      }],
    }, undefined, undefined, leadCtx);
    const direct = taskFrom(directResult);
    assertCurrentTaskShape(direct);
    expect(direct.status).toBe("open");
    expect(directResult.content[0].text).not.toBe(JSON.stringify(directResult.details));
    expect(directResult.details).toMatchObject({
      kind: "task_create_batch",
      outcomes: [{ kind: "created", task: { id: direct.id, status: "open", version: direct.version } }],
    });
    expect(directResult.content[0].text).not.toContain("deterministic test command");

    // This evaluator intentionally races two public-tool claims against the
    // same Task. Under full-suite Beads load, the winner can hold the local
    // Task lock across several `bd` subprocesses for longer than the default
    // five-second wait budget. Extend only this test's claim budget so the
    // evaluator still observes one committed claim and one stale-version
    // refusal; a leaked lock still fails after the bounded 30-second budget.
    const claimWithResult = BeadsTaskStore.prototype.claimWithResult;
    vi.spyOn(BeadsTaskStore.prototype, "claimWithResult").mockImplementation(function (
      this: BeadsTaskStore,
      taskId: string,
      actor?: string,
      options: TaskWriteOptions = {},
    ) {
      return claimWithResult.call(this, taskId, actor, { ...options, retries: 300 });
    });

    const claimResults = await Promise.all([
      updateA.execute("claim-a", {
        team_name: teamName,
        task_id: direct.id,
        claim: true,
        expected_version: direct.version,
      }, undefined, undefined, workerACtx),
      updateB.execute("claim-b", {
        team_name: teamName,
        task_id: direct.id,
        claim: true,
        expected_version: direct.version,
      }, undefined, undefined, workerBCtx),
    ]);
    const acceptedClaims = claimResults.filter((result) => result.details.kind === "task_update_batch" && result.details.outcomes.some((outcome: any) => outcome.kind === "updated"));
    const refusedClaims = claimResults.filter((result) => result.details.kind === "task_update_batch" && result.details.outcomes.some((outcome: any) => outcome.kind === "refused"));
    expect(acceptedClaims).toHaveLength(1);
    expect(refusedClaims).toHaveLength(1);
    const claimed = taskFrom(acceptedClaims[0]);
    expect(claimed).toMatchObject({ status: "in_progress" });
    expect(["worker-a", "worker-b"]).toContain(claimed.assignee);
    expect(refusedClaims[0].content[0].text).toMatch(/not updated|stale|review it and retry/i);
    expect(refusedClaims[0].details).toMatchObject({
      kind: "task_update_batch",
      outcomes: [{
        kind: "refused",
        task_id: direct.id,
        reason: "version_conflict",
        current_task: { id: direct.id, status: "in_progress", version: claimed.version },
        state_changed: false,
      }],
    });

    // Complex work remains one Task. Design is supplemented as prose, review is
    // requested in the Task itself, observed through team_sync, and approval is
    // just a Task transition.
    const complexCreated = taskFrom(await create.execute("create-complex", {
      team_name: teamName,
      title: "Refactor persistence boundary",
      description: "Preserve durability and fail closed on conflicts.",
      acceptance_criteria: "The durability evaluator passes and conflicting writes fail closed.",
      assignee: "worker-a",
    }, undefined, undefined, leadCtx));
    const beforeDesignSync = await sync.execute("sync-before-design", {
      team_name: teamName,
    }, undefined, undefined, leadCtx);
    const designedResult = await updateA.execute("supplement-design", {
      team_name: teamName,
      task_id: complexCreated.id,
      design: "First characterize existing writes, then replace one boundary and run the durability evaluator.",
      append_note: "Evidence gathered from the current write path.\n\nRequesting leader review of the proposed design.",
      expected_version: complexCreated.version,
    }, undefined, undefined, workerACtx);
    const designed = taskFrom(designedResult);
    expect(designed).toMatchObject({ status: "open", assignee: "worker-a" });
    expect(designed.design).toContain("Evidence gathered from the current write path.");

    const reviewSync = await sync.execute("sync-review-request", { view: "updates" }, undefined, undefined, leadCtx);
    expect(reviewSync.details).toMatchObject({ kind: expect.stringMatching(/updates|snapshot|contract_gap/) });
    expect(JSON.parse(reviewSync.content[0].text)).toMatchObject({ kind: expect.stringMatching(/updates|snapshot|contract_gap/) });
    expect(taskFrom(await read.execute("read-after-sync", {
      team_name: teamName,
      task_id: designed.id,
    }, undefined, undefined, leadCtx)).version).toBe(designed.version);

    const approved = taskFrom(await updateLead.execute("approve-as-transition", {
      team_name: teamName,
      task_id: designed.id,
      status: "in_progress",
      append_note: "Leader reviewed the current design and approved execution.",
      expected_version: designed.version,
    }, undefined, undefined, leadCtx));
    expect(approved).toMatchObject({ status: "in_progress" });
    expect(approved.notes).toContain("approved execution");

    const staleWrite = await updateA.execute("stale-write", {
      team_name: teamName,
      task_id: designed.id,
      append_note: "This must not overwrite the accepted version.",
      expected_version: designed.version,
    }, undefined, undefined, workerACtx);
    expect(staleWrite.content[0].text).toMatch(/not updated|stale|review it and retry/i);
    expect(staleWrite.details).toMatchObject({
      kind: "task_update_batch",
      outcomes: [{
        kind: "refused",
        task_id: designed.id,
        reason: "version_conflict",
        current_task: { id: designed.id, status: "in_progress", version: approved.version },
        state_changed: false,
      }],
    });

    const rejectedCreated = taskFrom(await create.execute("create-review-reject", {
      team_name: teamName,
      title: "Evaluate risky cleanup",
      description: "Do not execute until the current design has been reviewed.",
      acceptance_criteria: "Every generated path is inventoried and classified before deletion.",
      assignee: "worker-a",
    }, undefined, undefined, leadCtx));
    const rejectedDesign = taskFrom(await updateA.execute("design-for-rejection", {
      team_name: teamName,
      task_id: rejectedCreated.id,
      design: "Delete every generated directory in one pass.",
      append_note: "Requesting review because this cleanup is destructive.",
      expected_version: rejectedCreated.version,
    }, undefined, undefined, workerACtx));
    const rejected = taskFrom(await updateLead.execute("reject-by-feedback", {
      team_name: teamName,
      task_id: rejectedCreated.id,
      append_note: "Rejected: inventory and classify paths first; keep the Task open and revise its design.",
      expected_version: rejectedDesign.version,
    }, undefined, undefined, leadCtx));
    expect(rejected.status).toBe("open");
    expect(rejected.design).toContain("Rejected:");
    expect(rejected.notes).toContain("Rejected:");

    const blocker = taskFrom(await create.execute("create-blocker", {
      team_name: teamName,
      title: "Resolve upstream format",
      description: "Choose one stable format.",
    }, undefined, undefined, leadCtx));
    const dependent = taskFrom(await create.execute("create-dependent", {
      team_name: teamName,
      title: "Consume upstream format",
      description: "Integrate the chosen format.",
    }, undefined, undefined, leadCtx));
    const linked = taskFrom(await link.execute("link-blocked", {
      team_name: teamName,
      task_id: dependent.id,
      relation: "blocked_by",
      target_id: blocker.id,
      action: "add",
      expected_version: dependent.version,
    }, undefined, undefined, leadCtx));
    expect(linked.relations).toContainEqual({ relation: "blocked_by", targetId: blocker.id });

    const staleBlockedRemove = await link.execute("unlink-blocked-stale", {
      team_name: teamName,
      task_id: dependent.id,
      relation: "blocked_by",
      target_id: blocker.id,
      action: "remove",
      expected_version: dependent.version,
    }, undefined, undefined, leadCtx);
    expect(staleBlockedRemove.details).toMatchObject({
      kind: "refused",
      task_id: dependent.id,
      reason: "version_conflict",
      state_changed: false,
    });

    const freshBlocker = taskFrom(await read.execute("read-blocker-before-cycle", {
      team_name: teamName,
      task_id: blocker.id,
    }, undefined, undefined, leadCtx));
    const cycle = await link.execute("reject-cycle", {
      team_name: teamName,
      task_id: blocker.id,
      relation: "blocked_by",
      target_id: dependent.id,
      action: "add",
      expected_version: freshBlocker.version,
    }, undefined, undefined, leadCtx);
    expect(cycle.details).toMatchObject({ kind: "refused", reason: "graph_conflict", state_changed: false });

    const unlinked = taskFrom(await link.execute("unlink-blocked", {
      team_name: teamName,
      task_id: dependent.id,
      relation: "blocked_by",
      target_id: blocker.id,
      action: "remove",
      expected_version: linked.version,
    }, undefined, undefined, leadCtx));
    expect(unlinked.relations).not.toContainEqual({ relation: "blocked_by", targetId: blocker.id });

    const related = taskFrom(await link.execute("link-related", {
      team_name: teamName,
      task_id: dependent.id,
      relation: "related",
      target_id: blocker.id,
      action: "add",
      expected_version: unlinked.version,
    }, undefined, undefined, leadCtx));
    expect(related.relations).toContainEqual({ relation: "related", targetId: blocker.id });
    const unrelated = taskFrom(await link.execute("unlink-related", {
      team_name: teamName,
      task_id: dependent.id,
      relation: "related",
      target_id: blocker.id,
      action: "remove",
      expected_version: related.version,
    }, undefined, undefined, leadCtx));
    expect(unrelated.relations).not.toContainEqual({ relation: "related", targetId: blocker.id });

    const parent = taskFrom(await create.execute("create-parent", {
      team_name: teamName,
      title: "Parent work",
      description: "Own the larger outcome.",
    }, undefined, undefined, leadCtx));
    const child = taskFrom(await create.execute("create-child", {
      team_name: teamName,
      title: "Child work",
      description: "Deliver one contained part.",
    }, undefined, undefined, leadCtx));
    const parentedResult = await link.execute("link-parent", {
      team_name: teamName,
      task_id: child.id,
      relation: "parent",
      target_id: parent.id,
      action: "add",
      expected_version: child.version,
    }, undefined, undefined, leadCtx);
    const parented = taskFrom(parentedResult);
    expect(parented.relations).toContainEqual({ relation: "parent", targetId: parent.id });
    expect(parentedResult.details).toMatchObject({ kind: "task_linked", task_id: child.id, target_id: parent.id, relation: "parent", action: "add", changed: true, version: parented.version });

    const duplicateParent = await link.execute("link-parent-idempotent", {
      team_name: teamName,
      task_id: child.id,
      relation: "parent",
      target_id: parent.id,
      action: "add",
      expected_version: parented.version,
    }, undefined, undefined, leadCtx);
    expect(duplicateParent.details).toMatchObject({ kind: "task_linked", task_id: child.id, target_id: parent.id, relation: "parent", action: "add", changed: false, version: parented.version });
    expect(duplicateParent.content[0].text).not.toMatch(/delivery/i);
    const competingParent = taskFrom(await create.execute("create-competing-parent", {
      team_name: teamName,
      title: "Competing parent",
      description: "Must not silently replace the existing parent.",
    }, undefined, undefined, leadCtx));
    const refusedReparent = await link.execute("reject-implicit-reparent", {
      team_name: teamName,
      task_id: child.id,
      relation: "parent",
      target_id: competingParent.id,
      action: "add",
      expected_version: parented.version,
    }, undefined, undefined, leadCtx);
    expect(refusedReparent.content[0].text).toMatch(/already has parent|remove.*parent/i);
    expect(refusedReparent.details).toMatchObject({
      kind: "refused",
      task_id: child.id,
      reason: "graph_conflict",
      state_changed: false,
    });
    const unparentedResult = await link.execute("unlink-parent", {
      team_name: teamName,
      task_id: child.id,
      relation: "parent",
      target_id: parent.id,
      action: "remove",
      expected_version: parented.version,
    }, undefined, undefined, leadCtx);
    const unparented = taskFrom(unparentedResult);
    expect(unparented.relations).not.toContainEqual({ relation: "parent", targetId: parent.id });
    expect(unparentedResult.details).toMatchObject({
      kind: "task_linked",
      task_id: child.id,
      target_id: parent.id,
      relation: "parent",
      action: "remove",
      changed: true,
      version: unparented.version,
    });

    const duplicateUnparent = await link.execute("unlink-parent-idempotent", {
      team_name: teamName,
      task_id: child.id,
      relation: "parent",
      target_id: parent.id,
      action: "remove",
      expected_version: unparented.version,
    }, undefined, undefined, leadCtx);
    expect(duplicateUnparent.details).toMatchObject({
      kind: "task_linked",
      task_id: child.id,
      target_id: parent.id,
      relation: "parent",
      action: "remove",
      changed: false,
      version: unparented.version,
    });
    expect(duplicateUnparent.content[0].text).not.toMatch(/delivery/i);

    // Reasoning reads expose full prose; mutation content stays compact and the
    // machine-facing receipt retains the post-state and safety evidence.
    const readResult = await read.execute("read-full", {
      team_name: teamName,
      task_id: designed.id,
    }, undefined, undefined, leadCtx);
    expect(readResult.content[0].text).not.toBe(JSON.stringify(readResult.details));
    const readTask = taskFrom(readResult);
    assertCurrentTaskShape(readTask);
    expect(readTask).toMatchObject({
      id: designed.id,
      title: "Refactor persistence boundary",
      description: "The durability evaluator passes and conflicting writes fail closed.",
      status: "in_progress",
      assignee: "worker-a",
      version: approved.version,
    });
    expect(designedResult.details).toMatchObject({
      kind: "task_update_batch",
      outcomes: [{
        kind: "updated",
        task_id: designed.id,
        operation_id: "supplement-design",
        task: expect.objectContaining({ id: designed.id, status: "open" }),
        journal_entries: expect.any(Array),
      }],
    });

    // `deferred` exists in native Beads but is deliberately outside this
    // minimal collaboration vocabulary. The adapter must expose it honestly
    // or reject it; silently projecting it as `open` would lose authority state.
    const deferred = taskFrom(await create.execute("create-deferred", {
      team_name: teamName,
      title: "Externally deferred work",
      description: "Used to exercise backend schema drift.",
    }, undefined, undefined, leadCtx));
    execFileSync("bd", ["--directory", taskWorkspace, "--json", "update", deferred.id, "--status", "deferred"], {
      stdio: "ignore",
    });
    await expect(read.execute("read-deferred", {
      team_name: teamName,
      task_id: deferred.id,
    }, undefined, undefined, leadCtx)).rejects.toThrow(/deferred|unsupported|status/i);
  });
});
