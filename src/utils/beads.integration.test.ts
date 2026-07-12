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
  }, 60_000);

  it("migrates legacy tasks, claims one, and preserves authority across restart", async () => {
    const team = `integration-migration-${process.pid}`;
    teams.push(team);
    createTeam(team, "integration", "lead");
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
  }, 60_000);
});
