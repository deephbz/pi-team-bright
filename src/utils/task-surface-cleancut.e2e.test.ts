import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { defaultBdRunner, readBeadsAuthorityFingerprint } from "./beads";
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
    for (const name of ["task_graph_apply", "task_read", "team_sync"]) {
      const tool = tools.get(name);
      if (!tool) continue;
      const originalExecute = tool.execute;
      tools.set(name, { ...tool, execute: async (id, params, signal, update, ctx) => {
        const args: any = { ...params };
        if (name === "task_graph_apply") {
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
  const graphTask = result?.details?.kind === "task_graph_applied"
    ? Object.values(result.details.tasks_by_key)[0]
    : undefined;
  const task = result?.details?.task || result?.details?.postState || outcome?.task || graphTask;
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
    status: expect.stringMatching(/^(dependency_waiting|ready|in_progress|blocked|goal_failed|goal_achieved|cancelled)$/),
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
      "task_graph_apply",
      "task_read",
      "task_update",
    ]);
    expect(tools.has("team_sync")).toBe(true);

    expect(schemaKeys(tools.get("task_graph_apply"))).toEqual(["expected_graph_version", "operation_id", "tasks"]);
    expect((tools.get("task_graph_apply")!.parameters as any).properties.tasks.items.properties).toHaveProperty("needs");
    expect(schemaKeys(tools.get("task_update"))).toEqual(["current_context", "evidence", "expected_version", "operation_id", "task_id", "transition"]);
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

  it("supports complete graph apply, exact singleton claims, stale-write rejection, context, and derived waiting", async () => {
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

    const applyGraph = lead.get("task_graph_apply")!;
    const updateA = workerA.get("task_update")!;
    const updateB = workerB.get("task_update")!;
    const read = lead.get("task_read")!;
    const sync = lead.get("team_sync")!;

    const firstApply = await applyGraph.execute("apply-direct", {
      operation_id: "apply-direct",
      tasks: [{
        key: "direct",
        title: "Run deterministic checks",
        goal: "Execute the deterministic test command and confirm it exits successfully.",
        assignee: "worker-a",
      }],
    }, undefined, undefined, leadCtx);
    const direct = taskFrom(firstApply);
    assertCurrentTaskShape(direct);
    expect(direct.status).toBe("ready");
    expect(firstApply.content[0].text).not.toBe(JSON.stringify(firstApply.details));
    expect(firstApply.details).toMatchObject({
      kind: "task_graph_applied",
      operation_id: "apply-direct",
      graph_version: expect.stringMatching(/^g_[0-9a-f]{16}$/),
      tasks_by_key: { direct: { id: direct.id, status: "ready", version: direct.version } },
      ready_task_ids: [direct.id],
    });
    expect(firstApply.content[0].text).not.toContain("deterministic test command");

    const claimResults = await Promise.all([
      updateA.execute("claim-a", {
        task_id: direct.id,
        operation_id: "claim-a",
        transition: "claim",
        expected_version: expectedVersionRef(direct.version),
      }, undefined, undefined, workerACtx),
      updateB.execute("claim-b", {
        task_id: direct.id,
        operation_id: "claim-b",
        transition: "claim",
        expected_version: expectedVersionRef(direct.version),
      }, undefined, undefined, workerBCtx),
    ]);
    const acceptedClaims = claimResults.filter((result) => result.details.kind === "updated");
    const refusedClaims = claimResults.filter((result) => result.details.kind === "refused");
    expect(acceptedClaims).toHaveLength(1);
    expect(refusedClaims).toHaveLength(1);
    const claimed = taskFrom(acceptedClaims[0]);
    expect(claimed).toMatchObject({ status: "in_progress", assignee: "worker-a" });
    expect(refusedClaims[0].content[0].text).toMatch(/stale|version/i);
    expect(refusedClaims[0].details).toMatchObject({
      kind: "refused",
      task_id: direct.id,
      reason: expect.stringMatching(/version_conflict|worker_mismatch/),
      state_changed: false,
    });
    expect(claimed.version).not.toBe(direct.version);

    const contextUpdated = await updateA.execute("supplement-context", {
      task_id: direct.id,
      operation_id: "supplement-context",
      expected_version: expectedVersionRef(claimed.version),
      current_context: "The deterministic checks are running against the exact graph revision.",
    }, undefined, undefined, workerACtx);
    const contextual = taskFrom(contextUpdated);
    expect(contextual).toMatchObject({
      status: "in_progress",
      assignee: "worker-a",
      current_context: "The deterministic checks are running against the exact graph revision.",
    });

    const staleWrite = await updateA.execute("stale-write", {
      task_id: direct.id,
      operation_id: "stale-write",
      expected_version: expectedVersionRef(claimed.version),
      current_context: "This must not overwrite the current version.",
    }, undefined, undefined, workerACtx);
    expect(staleWrite.content[0].text).toMatch(/stale|version/i);
    expect(staleWrite.details).toMatchObject({
      kind: "refused",
      task_id: direct.id,
      reason: "version_conflict",
      current_task: { id: direct.id, status: "in_progress", version: contextual.version },
      state_changed: false,
    });

    const firstRead = await read.execute("read-direct", {
      task_ids: [direct.id],
    }, undefined, undefined, leadCtx);
    expect(firstRead.details).toMatchObject({
      kind: "task_read_batch",
      outcomes: [{ kind: "found", task: { version: contextual.version, status: "in_progress" } }],
    });
    const firstSync = await sync.execute("sync-current", { view: "snapshot" }, undefined, undefined, leadCtx);
    expect(firstSync.details).toMatchObject({ kind: expect.stringMatching(/snapshot|updates|caught_up/) });

    const graphResult = await applyGraph.execute("apply-dependent-graph", {
      operation_id: "apply-dependent-graph",
      expected_graph_version: firstApply.details.graph_version,
      tasks: [
        { key: "format", title: "Resolve upstream format", goal: "Choose one stable format.", assignee: "worker-a" },
        { key: "consume", title: "Consume upstream format", goal: "Integrate the chosen format.", assignee: "worker-b", needs: ["format"] },
      ],
    }, undefined, undefined, leadCtx);
    expect(graphResult.details).toMatchObject({
      kind: "task_graph_applied",
      ready_task_ids: [graphResult.details.tasks_by_key.format.id],
      tasks_by_key: {
        format: { status: "ready", dependency_state: { kind: "ready", active_blocker_ids: [] } },
        consume: {
          status: "dependency_waiting",
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
      outcomes: [{ kind: "found", task: { status: "dependency_waiting", dependency_state: { kind: "waiting" } } }],
    });
  });
});
