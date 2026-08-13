import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { BeadsTaskStore, defaultBdRunner, readBeadsAuthorityFingerprint, type TaskWriteOptions } from "./beads";
import type { TeamConfig } from "./models";
import * as paths from "./paths";
import * as teams from "./teams";
import { taskVersionRef } from "../../src/model-tool-contract/task-version-ref";

function expectedVersionRef(value: string): string {
  return /^v_[0-9a-f]{16}$/.test(value) ? value : taskVersionRef(value);
}

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

// This applies only to the intentional two-Worker claim race below. It leaves
// production's 5-second lock authority budget unchanged.
const AGGREGATE_E2E_CLAIM_LOCK_RETRIES = 1_200;

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
    for (const name of ["task_create", "task_update", "task_read", "team_sync"]) {
      const tool = tools.get(name);
      if (!tool) continue;
      const originalExecute = tool.execute;
      tools.set(name, { ...tool, execute: async (id, params, signal, update, ctx) => {
        const args: any = { ...params };
        if (name === "task_create") {
          const sourceTasks = args.tasks ?? [{ title: args.title, goal: args.acceptance_criteria || args.description || "Complete the requested Task.", ...(args.assignee ? { assignee: args.assignee } : {}) }];
          args.operation_id = args.operation_id || sourceTasks[0]?.operation_id || `cleancut-${id}`;
          args.tasks = sourceTasks.map((task: any, index: number) => ({
            key: task.key || `task-${index + 1}`,
            title: task.title,
            goal: task.goal || task.acceptance_criteria || task.description || "Complete the requested Task.",
            ...(task.assignee ? { assignee: task.assignee } : {}),
            ...(task.needs ? { needs: [...task.needs] } : {}),
          }));
          for (const key of ["team_name", "title", "description", "acceptance_criteria", "assignee", "design", "idempotency_key"]) delete args[key];
        } else if (name === "task_update" && !args.updates) {
          args.updates = [{ task_id: args.task_id, operation_id: `cleancut-${id}`, expected_version: expectedVersionRef(args.expected_version || ""), current_context: args.design || args.append_note || "Task evidence was reviewed.", journal_entries: [{ kind: "note", text: args.append_note || args.design || "Task evidence was reviewed." }], ...(args.status ? { status: args.status } : {}) }];
          for (const key of ["team_name", "task_id", "claim", "assignee", "description", "design", "append_note", "expected_version", "status", "title"]) delete args[key];
        } else if (name === "task_read" && args.task_id) {
          args.task_ids = [args.task_id]; delete args.task_id; delete args.team_name;
        } else if (name === "team_sync") {
          args.view = args.view || (args.cursor ? "updates" : "snapshot"); delete args.team_name; delete args.cursor; delete args.wait_ms; delete args.event_types; delete args.task_ids; delete args.limit; delete args.continuation;
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
  const graphTask = result?.details?.kind === "task_graph_created"
    ? Object.values(result.details.tasks_by_key)[0]
    : undefined;
  const task = result?.details?.postState || outcome?.task || graphTask;
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

function cleanupTestArtifacts(): void {
  const names = testTeams.splice(0);
  const roots = testRoots.splice(0);
  const failures: string[] = [];
  for (const name of names) {
    try {
      fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    } catch (error) {
      failures.push(`Team ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(`Temporary root ${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`Task-surface test cleanup failed:\n${failures.join("\n")}`);
}

afterEach(() => {
  try {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  } finally {
    cleanupTestArtifacts();
  }
});

describe("clean-cut Task public surface", () => {
  it("exports three stable Task verbs plus team_sync and no plan or legacy-schema escape hatches", () => {
    const tools = extensionHarness();
    expect([...tools.keys()].filter((name) => name.startsWith("task_")).sort()).toEqual([
      "task_create",
      "task_read",
      "task_update",
    ]);
    expect(tools.has("team_sync")).toBe(true);

    expect(schemaKeys(tools.get("task_create"))).toEqual(["operation_id", "tasks"]);
    expect((tools.get("task_create")!.parameters as any).properties.tasks.items.properties).toHaveProperty("needs");
    expect(schemaKeys(tools.get("task_update"))).toEqual(["updates"]);
    expect(tools.has("task_link")).toBe(false);

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

  it("removes registered Team and Beads roots after an injected setup error", () => {
    expect(hasBd, "The clean-cut E2E requires the sole Task authority CLI (`bd`) to be installed.").toBe(true);
    const teamName = uniqueTeam("cleanup-error");
    const workspace = initBeadsWorkspace();
    const root = path.dirname(workspace);
    writeTeam(teamName, workspace);

    try {
      throw new Error("injected setup failure");
    } catch (error) {
      expect(error).toMatchObject({ message: "injected setup failure" });
    } finally {
      cleanupTestArtifacts();
    }

    expect(fs.existsSync(paths.teamDir(teamName))).toBe(false);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("supports DAG creation, direct execution, prose review, stale-write rejection, notes, and claims", async () => {
    expect(hasBd, "The clean-cut E2E requires the sole Task authority CLI (`bd`) to be installed.").toBe(true);
    const runBd = defaultBdRunner.run.bind(defaultBdRunner);
    vi.spyOn(defaultBdRunner, "run").mockImplementation((args, options) =>
      runBd(args, { ...options, timeoutMs: Math.max(options.timeoutMs, 30_000) }));
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
    const sync = lead.get("team_sync")!;

    // Simple work skips review: atomic claim is the only safety-specialized mutation.
    const directResult = await create.execute("create-direct", {
      tasks: [{
        operation_id: "create-deterministic-checks",
        title: "Run deterministic checks",
        goal: "Execute the deterministic test command and confirm it exits successfully.",
        assignee: "worker-a",
      }],
    }, undefined, undefined, leadCtx);
    const direct = taskFrom(directResult);
    assertCurrentTaskShape(direct);
    expect(direct.status).toBe("open");
    expect(directResult.content[0].text).not.toBe(JSON.stringify(directResult.details));
    expect(directResult.details).toMatchObject({
      kind: "task_graph_created",
      operation_id: "create-deterministic-checks",
      tasks_by_key: { "task-1": { id: direct.id, status: "open", version: direct.version } },
    });
    expect(directResult.content[0].text).not.toContain("deterministic test command");

    // This evaluator intentionally races two public-tool claims against the
    // same Task. Under aggregate Beads load, the winner can hold the local
    // Task lock across several `bd` subprocesses for longer than production's
    // five-second authority budget. Extend only this evaluator's budget so it
    // still observes one committed claim and one stale-version refusal. A
    // leaked lock remains bounded to two minutes, below this test's timeout.
    const claimWithResult = BeadsTaskStore.prototype.claimWithResult;
    vi.spyOn(BeadsTaskStore.prototype, "claimWithResult").mockImplementation(function (
      this: BeadsTaskStore,
      taskId: string,
      actor?: string,
      options: TaskWriteOptions = {},
    ) {
      return claimWithResult.call(this, taskId, actor, { ...options, retries: AGGREGATE_E2E_CLAIM_LOCK_RETRIES });
    });

    const claimResults = await Promise.all([
      updateA.execute("claim-a", {
        team_name: teamName,
        task_id: direct.id,
        operation_id: "claim-a",
        claim: true,
        expected_version: expectedVersionRef(direct.version),
      }, undefined, undefined, workerACtx),
      updateB.execute("claim-b", {
        team_name: teamName,
        task_id: direct.id,
        operation_id: "claim-b",
        claim: true,
        expected_version: expectedVersionRef(direct.version),
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
        current_task: { id: direct.id, version: expect.any(String) },
        state_changed: false,
      }],
    });
    // Each concurrent receipt projects authority independently. The refused
    // read can observe owner-transition preparation before the winning claim.
    // Both versions must be post-create revisions; exact status or equality
    // between concurrent observations isn't the stale-write safety invariant.
    const refusedCurrent = refusedClaims[0].details.outcomes[0].current_task;
    expect(claimed.version).not.toBe(direct.version);
    expect(refusedCurrent.version).not.toBe(direct.version);

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
      operation_id: "supplement-design",
      current_context: "First characterize existing writes, then replace one boundary and run the durability evaluator.",
      journal_entries: [{ kind: "note", text: "Evidence gathered from the current write path.\n\nRequesting leader review of the proposed design." }],
      expected_version: expectedVersionRef(complexCreated.version),
    }, undefined, undefined, workerACtx);
    const designed = taskFrom(designedResult);
    expect(designed).toMatchObject({ status: "open", assignee: "worker-a" });
    expect(designed.notes).toContain("Evidence gathered from the current write path.");

    const oversizedContext = await updateA.execute("oversized-context", {
      team_name: teamName,
      task_id: designed.id,
      operation_id: "oversized-context",
      current_context: "👩🏽‍🚀".repeat(2_001),
      journal_entries: [{ kind: "note", text: "oversized context" }],
      expected_version: expectedVersionRef(designed.version),
    }, undefined, undefined, workerACtx);
    expect(oversizedContext.details).toMatchObject({
      kind: "task_update_batch",
      outcomes: [{
        kind: "contract_gap",
        reason: "task_metadata_invalid",
        task_id: designed.id,
        state_changed: false,
      }],
    });
    expect(taskFrom(await read.execute("read-after-oversized-context", {
      team_name: teamName,
      task_id: designed.id,
    }, undefined, undefined, leadCtx)).version).toBe(designed.version);

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
      operation_id: "stale-write",
      current_context: "This must not overwrite the accepted version.",
      journal_entries: [{ kind: "note", text: "This must not overwrite the accepted version." }],
      expected_version: expectedVersionRef(designed.version),
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

    const graphResult = await create.execute("create-dependent-graph", {
      operation_id: "create-dependent-graph",
      tasks: [
        { key: "format", title: "Resolve upstream format", goal: "Choose one stable format.", assignee: "worker-a" },
        { key: "consume", title: "Consume upstream format", goal: "Integrate the chosen format.", assignee: "worker-b", needs: ["format"] },
      ],
    }, undefined, undefined, leadCtx);
    expect(graphResult.details).toMatchObject({
      kind: "task_graph_created",
      ready_task_ids: [graphResult.details.tasks_by_key.format.id],
      tasks_by_key: {
        format: { dependency_state: { kind: "ready", active_blocker_ids: [] } },
        consume: {
          relations: [{ relation: "blocked_by", target_task_id: graphResult.details.tasks_by_key.format.id }],
          dependency_state: { kind: "waiting", active_blocker_ids: [graphResult.details.tasks_by_key.format.id] },
        },
      },
    });

    const dependentRead = await read.execute("read-dependent", {
      task_ids: [graphResult.details.tasks_by_key.consume.id],
    }, undefined, undefined, leadCtx);
    expect(dependentRead.details).toMatchObject({
      kind: "task_read_batch",
      outcomes: [{ kind: "found", task: { dependency_state: { kind: "waiting" } } }],
    });
  });
});
