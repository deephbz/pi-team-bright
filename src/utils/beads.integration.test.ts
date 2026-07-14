import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { BeadsTaskStore } from "./beads";
import { TaskFile } from "./models";
import { configPath, taskDir, teamDir } from "./paths";
import { createTeam } from "./teams";
import { migrateTeamTasks } from "./task-migration";

const hasBd = spawnSync("bd", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasBd)("BeadsTaskStore against a temporary bd repository", () => {
  const workspaces: string[] = [];
  const teams: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) fs.rmSync(workspace, { recursive: true, force: true });
    for (const team of teams.splice(0)) {
      fs.rmSync(teamDir(team), { recursive: true, force: true });
      fs.rmSync(taskDir(team), { recursive: true, force: true });
    }
  });

  it("persists task authority across store restart", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-beads-integration-"));
    workspaces.push(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("bd", ["init", "--quiet"], { cwd: workspace, stdio: "ignore" });

    const first = new BeadsTaskStore({ teamName: "integration", workspace, actor: "lead", requireExpectedVersion: false });
    const blocker = await first.create({ subject: "Blocker", description: "unblocks work", idempotencyKey: "integration-blocker" });
    const task = await first.create({ subject: "Work", description: "survives restart", idempotencyKey: "integration-task" });
    await first.claim(task.id, "worker");
    await first.addDependency(task.id, blocker.id);
    await first.addProgress(task.id, { kind: "progress", text: "checkpoint", actor: "worker" });

    const restarted = new BeadsTaskStore({ teamName: "integration", workspace, actor: "lead", requireExpectedVersion: false });
    const persisted = await restarted.read(task.id);
    expect(persisted.id).toBe(task.id);
    expect(persisted.owner).toBe("worker");
    expect(persisted.blockedBy).toEqual([blocker.id]);
    expect(persisted.metadata?.progressEntries).toEqual([expect.objectContaining({ text: "checkpoint", actor: "worker" })]);

    await restarted.submitPlan(task.id, "finish it");
    await restarted.evaluatePlan(task.id, "approve");
    await restarted.update(blocker.id, { status: "completed" });
    expect((await restarted.update(task.id, { status: "completed" })).status).toBe("completed");
    expect((await restarted.read(task.id)).status).toBe("completed");
  }, 120_000);

  it("migrates legacy tasks, claims one, and preserves authority across restart", async () => {
    const team = `integration-migration-${process.pid}`;
    teams.push(team);
    await createTeam(team, "integration", "lead");
    const blocker: TaskFile = { id: "1", subject: "Blocker", description: "first", status: "pending", blocks: ["2"], blockedBy: [] };
    const task: TaskFile = { id: "2", subject: "Work", description: "second", status: "pending", blocks: [], blockedBy: ["1"] };
    fs.writeFileSync(path.join(taskDir(team), "1.json"), JSON.stringify(blocker, null, 2));
    fs.writeFileSync(path.join(taskDir(team), "2.json"), JSON.stringify(task, null, 2));

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-beads-migration-"));
    workspaces.push(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("bd", ["init", "--quiet"], { cwd: workspace, stdio: "ignore" });
    const report = await migrateTeamTasks({ teamName: team, workspace });
    expect(report.cutover).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath(team), "utf8")).taskBackend).toBe("beads");

    const first = new BeadsTaskStore({ teamName: team, workspace, actor: "lead" });
    const migrated = await first.read(report.mapping["2"]);
    const claimed = await first.claim(migrated.id, "worker");
    expect(claimed.owner).toBe("worker");
    const restarted = new BeadsTaskStore({ teamName: team, workspace, actor: "lead" });
    expect((await restarted.read(migrated.id)).owner).toBe("worker");
    const cutoverStore = new BeadsTaskStore({ teamName: team, workspace, actor: "lead", requireExpectedVersion: true });
    await expect(cutoverStore.update(migrated.id, { description: "missing token" })).rejects.toMatchObject({ kind: "conflict" });
    const current = await cutoverStore.read(migrated.id);
    await expect(cutoverStore.update(migrated.id, { description: "versioned" }, { expectedVersion: current.version })).resolves.toMatchObject({ description: "versioned" });
  }, 120_000);

  it("migrates completed and deleted legacy tasks without loss and reruns idempotently", async () => {
    const team = `integration-terminal-migration-${process.pid}`;
    teams.push(team);
    await createTeam(team, "integration", "lead");
    const completed: TaskFile = {
      id: "1",
      subject: "Completed legacy work",
      description: "retain completed details",
      activeForm: "Finishing",
      status: "completed",
      plan: "preserve the plan",
      planFeedback: "accepted",
      blocks: [],
      blockedBy: [],
      owner: "alice",
      metadata: { source: "legacy-completed" },
    };
    const deleted: TaskFile = {
      id: "2",
      subject: "Deleted legacy work",
      description: "retain deleted details",
      status: "deleted",
      blocks: [],
      blockedBy: [],
      owner: "bob",
      metadata: { source: "legacy-deleted" },
    };
    fs.writeFileSync(path.join(taskDir(team), "1.json"), JSON.stringify(completed, null, 2));
    fs.writeFileSync(path.join(taskDir(team), "2.json"), JSON.stringify(deleted, null, 2));

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-terminal-migration-"));
    workspaces.push(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks"], { cwd: workspace, stdio: "ignore" });

    const first = await migrateTeamTasks({ teamName: team, workspace });
    expect(first.cutover).toBe(true);
    expect(first.errors).toEqual([]);
    expect(first.mismatches).toEqual([]);
    expect(first.before.count).toBe(2);
    expect(first.after.count).toBe(2);
    expect(first.after.beadsIds).toEqual([first.mapping["1"], first.mapping["2"]].sort());
    expect(fs.existsSync(path.join(taskDir(team), "1.json"))).toBe(true);
    expect(fs.existsSync(path.join(taskDir(team), "2.json"))).toBe(true);

    const store = new BeadsTaskStore({ teamName: team, workspace, actor: "lead", requireExpectedVersion: false });
    const completedAfter = await store.read(first.mapping["1"]);
    const deletedAfter = await store.read(first.mapping["2"]);
    expect(completedAfter).toMatchObject({
      subject: completed.subject,
      description: completed.description,
      activeForm: completed.activeForm,
      status: "completed",
      plan: completed.plan,
      planFeedback: completed.planFeedback,
      owner: completed.owner,
      metadata: expect.objectContaining({ source: "legacy-completed", pi_teams_legacy_id: "1" }),
    });
    expect(deletedAfter).toMatchObject({
      subject: deleted.subject,
      description: deleted.description,
      status: "deleted",
      owner: deleted.owner,
      metadata: expect.objectContaining({ source: "legacy-deleted", pi_teams_legacy_id: "2" }),
    });

    const rerun = await migrateTeamTasks({ teamName: team, workspace });
    expect(rerun).toMatchObject({ alreadyCutOver: true, cutover: true, authority: "beads" });
    expect(rerun.mapping).toEqual(first.mapping);
    expect(rerun.after).toEqual(first.after);
    expect(rerun.errors).toEqual([]);
    expect((await store.findByLegacyId("1"))?.id).toBe(first.mapping["1"]);
    expect((await store.findByLegacyId("2"))?.id).toBe(first.mapping["2"]);
    expect((await store.read(first.mapping["1"])).status).toBe("completed");
    expect((await store.read(first.mapping["2"])).status).toBe("deleted");
  }, 120_000);

  it("fails an empty-inventory rerun when its exact root is missing even if an ancestor Beads authority exists", async () => {
    const team = `integration-empty-migration-${process.pid}`;
    teams.push(team);
    await createTeam(team, "integration", "lead");
    const parentWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-parent-migration-"));
    workspaces.push(parentWorkspace);
    execFileSync("git", ["init", "-q"], { cwd: parentWorkspace });
    execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks"], { cwd: parentWorkspace, stdio: "ignore" });
    const workspace = path.join(parentWorkspace, "child");
    fs.mkdirSync(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks"], { cwd: workspace, stdio: "ignore" });

    const first = await migrateTeamTasks({ teamName: team, workspace });
    expect(first).toMatchObject({ cutover: true, before: { count: 0 }, after: { count: 0 }, errors: [] });
    fs.renameSync(path.join(workspace, ".beads"), path.join(workspace, ".beads-unavailable"));

    const rerun = await migrateTeamTasks({ teamName: team, workspace });

    expect(rerun).toMatchObject({ alreadyCutOver: true, cutover: true, authority: "beads" });
    expect(rerun.errors.join(" ")).toContain("not an initialized authority root");
    expect(await new BeadsTaskStore({ teamName: team, workspace: parentWorkspace, requireExpectedVersion: false }).list()).toEqual([]);
  }, 120_000);

  it("refuses initial migration into an uninitialized child of another Beads authority", async () => {
    const team = `integration-ancestor-migration-${process.pid}`;
    teams.push(team);
    await createTeam(team, "integration", "lead");
    fs.writeFileSync(path.join(taskDir(team), "1.json"), JSON.stringify({
      id: "1",
      subject: "Must not escape",
      description: "authority boundary",
      status: "pending",
      blocks: [],
      blockedBy: [],
    } satisfies TaskFile));
    const parentWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-parent-first-cutover-"));
    workspaces.push(parentWorkspace);
    execFileSync("git", ["init", "-q"], { cwd: parentWorkspace });
    execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks"], { cwd: parentWorkspace, stdio: "ignore" });
    const childWorkspace = path.join(parentWorkspace, "uninitialized-child");
    fs.mkdirSync(childWorkspace);

    const report = await migrateTeamTasks({ teamName: team, workspace: childWorkspace });

    expect(report.cutover).toBe(false);
    expect(report.errors.join(" ")).toContain("not an initialized authority root");
    expect((await new BeadsTaskStore({ teamName: team, workspace: parentWorkspace, requireExpectedVersion: false }).list())).toEqual([]);
    expect(JSON.parse(fs.readFileSync(configPath(team), "utf8")).taskBackend).toBeUndefined();
  }, 120_000);

  it("rejects a valid different Beads database swapped into the configured path", async () => {
    const team = `integration-swapped-authority-${process.pid}`;
    teams.push(team);
    await createTeam(team, "integration", "lead");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-original-authority-"));
    const replacement = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-replacement-authority-"));
    workspaces.push(workspace, replacement);
    for (const root of [workspace, replacement]) {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks"], { cwd: root, stdio: "ignore" });
    }
    const first = await migrateTeamTasks({ teamName: team, workspace });
    expect(first.errors).toEqual([]);
    const configuredFingerprint = JSON.parse(fs.readFileSync(configPath(team), "utf8")).taskAuthorityFingerprint;
    fs.renameSync(path.join(workspace, ".beads"), path.join(workspace, ".beads-original"));
    fs.renameSync(path.join(replacement, ".beads"), path.join(workspace, ".beads"));

    const rerun = await migrateTeamTasks({ teamName: team, workspace });

    expect(rerun).toMatchObject({ alreadyCutOver: true, cutover: true, authority: "beads" });
    expect(rerun.errors.join(" ")).toContain("fingerprint mismatch");
    expect(JSON.parse(fs.readFileSync(configPath(team), "utf8")).taskAuthorityFingerprint).toEqual(configuredFingerprint);
  }, 120_000);
});
