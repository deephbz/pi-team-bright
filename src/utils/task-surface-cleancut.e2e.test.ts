import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { readBeadsAuthorityFingerprint } from "./beads";
import type { TeamConfig } from "./models";
import * as paths from "./paths";
import * as teams from "./teams";

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

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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
    leadAgentId: `lead@${name}`,
    leadSessionId: `/tmp/${name}-lead.jsonl`,
    taskBackend: "beads",
    taskWorkspace: workspace,
    taskAuthorityId: `task_authority_${crypto.randomUUID()}`,
    taskAuthorityFingerprint: readBeadsAuthorityFingerprint(workspace),
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
  const task = result?.details?.task;
  if (!task || typeof task !== "object") throw new Error(`missing structured Task receipt: ${JSON.stringify(result)}`);
  return task;
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
  it("exports five stable Task verbs and no plan or legacy-schema escape hatches", () => {
    const tools = extensionHarness();
    expect([...tools.keys()].filter((name) => name.startsWith("task_")).sort()).toEqual([
      "task_create",
      "task_link",
      "task_list",
      "task_read",
      "task_update",
    ]);

    expect(schemaKeys(tools.get("task_create"))).toEqual([
      "assignee",
      "description",
      "design",
      "idempotency_key",
      "team_name",
      "title",
    ]);
    expect(schemaKeys(tools.get("task_update"))).toEqual([
      "append_note",
      "assignee",
      "claim",
      "description",
      "design",
      "expected_version",
      "status",
      "task_id",
      "team_name",
      "title",
    ]);
    expect(schemaKeys(tools.get("task_link"))).toEqual([
      "action",
      "expected_version",
      "relation",
      "target_id",
      "task_id",
      "team_name",
    ]);

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
      "progress",
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

    // Simple work skips review: atomic claim is the only safety-specialized mutation.
    const directResult = await create.execute("create-direct", {
      team_name: teamName,
      title: "Run deterministic checks",
      description: "Execute the already-understood test command.",
    }, undefined, undefined, leadCtx);
    const direct = taskFrom(directResult);
    assertCurrentTaskShape(direct);
    expect(direct.status).toBe("open");
    expect(JSON.parse(directResult.content[0].text)).toEqual(expect.objectContaining({
      task: expect.objectContaining({ id: direct.id, status: "open" }),
    }));
    expect(directResult.content[0].text).not.toContain("already-understood");

    const [claimA, claimB] = await Promise.allSettled([
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
    expect([claimA, claimB].filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect([claimA, claimB].filter((result) => result.status === "rejected")).toHaveLength(1);
    const claimed = taskFrom(claimA.status === "fulfilled" ? claimA.value : (claimB as PromiseFulfilledResult<any>).value);
    expect(claimed).toMatchObject({ status: "in_progress" });
    expect(["worker-a", "worker-b"]).toContain(claimed.assignee);

    // Complex work remains one Task. Design is supplemented as prose, review is
    // requested through Communication, and approval is just a Task transition.
    const complexCreated = taskFrom(await create.execute("create-complex", {
      team_name: teamName,
      title: "Refactor persistence boundary",
      description: "Preserve durability and fail closed on conflicts.",
      assignee: "worker-a",
    }, undefined, undefined, leadCtx));
    const designedResult = await updateA.execute("supplement-design", {
      team_name: teamName,
      task_id: complexCreated.id,
      design: "First characterize existing writes, then replace one boundary and run the durability evaluator.",
      append_note: "Evidence gathered from the current write path.\n\nRequesting leader review of the proposed design.",
      expected_version: complexCreated.version,
    }, undefined, undefined, workerACtx);
    const designed = taskFrom(designedResult);
    expect(designed).toMatchObject({ status: "open", assignee: "worker-a" });
    expect(designed.design).toContain("characterize existing writes");
    expect(designed.notes).toContain("Evidence gathered from the current write path.\n\nRequesting leader review");

    const beforeMessageVersion = designed.version;
    await workerA.get("send_message")!.execute("request-review", {
      team_name: teamName,
      recipient: "team-lead",
      content: `Please review Task ${designed.id} at version ${designed.version}.`,
      summary: `Review requested for ${designed.id}`,
    }, undefined, undefined, workerACtx);
    expect(taskFrom(await read.execute("read-after-message", {
      team_name: teamName,
      task_id: designed.id,
    }, undefined, undefined, leadCtx)).version).toBe(beforeMessageVersion);

    const approved = taskFrom(await updateLead.execute("approve-as-transition", {
      team_name: teamName,
      task_id: designed.id,
      status: "in_progress",
      append_note: "Leader reviewed the current design and approved execution.",
      expected_version: designed.version,
    }, undefined, undefined, leadCtx));
    expect(approved).toMatchObject({ status: "in_progress" });
    expect(approved.notes).toContain("Evidence gathered");
    expect(approved.notes).toContain("approved execution");

    await expect(updateA.execute("stale-write", {
      team_name: teamName,
      task_id: designed.id,
      append_note: "This must not overwrite the accepted version.",
      expected_version: designed.version,
    }, undefined, undefined, workerACtx)).rejects.toThrow(/changed|version|conflict|re-read/i);

    const rejectedCreated = taskFrom(await create.execute("create-review-reject", {
      team_name: teamName,
      title: "Evaluate risky cleanup",
      description: "Do not execute until the current design has been reviewed.",
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
    expect(rejected.design).toBe(rejectedDesign.design);
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

    const freshBlocker = taskFrom(await read.execute("read-blocker-before-cycle", {
      team_name: teamName,
      task_id: blocker.id,
    }, undefined, undefined, leadCtx));
    await expect(link.execute("reject-cycle", {
      team_name: teamName,
      task_id: blocker.id,
      relation: "blocked_by",
      target_id: dependent.id,
      action: "add",
      expected_version: freshBlocker.version,
    }, undefined, undefined, leadCtx)).rejects.toThrow(/cycle|cyclic|dependency/i);

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
    const parented = taskFrom(await link.execute("link-parent", {
      team_name: teamName,
      task_id: child.id,
      relation: "parent",
      target_id: parent.id,
      action: "add",
      expected_version: child.version,
    }, undefined, undefined, leadCtx));
    expect(parented.relations).toContainEqual({ relation: "parent", targetId: parent.id });
    const competingParent = taskFrom(await create.execute("create-competing-parent", {
      team_name: teamName,
      title: "Competing parent",
      description: "Must not silently replace the existing parent.",
    }, undefined, undefined, leadCtx));
    await expect(link.execute("reject-implicit-reparent", {
      team_name: teamName,
      task_id: child.id,
      relation: "parent",
      target_id: competingParent.id,
      action: "add",
      expected_version: parented.version,
    }, undefined, undefined, leadCtx)).rejects.toThrow(/already.*parent|existing parent|remove.*parent|replace/i);
    const unparented = taskFrom(await link.execute("unlink-parent", {
      team_name: teamName,
      task_id: child.id,
      relation: "parent",
      target_id: parent.id,
      action: "remove",
      expected_version: parented.version,
    }, undefined, undefined, leadCtx));
    expect(unparented.relations).not.toContainEqual({ relation: "parent", targetId: parent.id });

    // Reasoning reads expose full prose; mutation content stays compact and the
    // machine-facing receipt retains the post-state and safety evidence.
    const readResult = await read.execute("read-full", {
      team_name: teamName,
      task_id: designed.id,
    }, undefined, undefined, leadCtx);
    expect(readResult.content[0].text).toContain("Refactor persistence boundary");
    expect(readResult.content[0].text).toContain("characterize existing writes");
    assertCurrentTaskShape(taskFrom(readResult));
    expect(designedResult.details).toEqual(expect.objectContaining({
      task: expect.any(Object),
      appliedOperations: expect.any(Array),
      deliveryWarnings: expect.any(Array),
    }));

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
