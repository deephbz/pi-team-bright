import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TaskFile } from "./models";
import { configPath, taskDir, teamDir } from "./paths";
import { migrateTeamTasks } from "./task-migration";

class MigrationBeadsFixture {
  tasks = new Map<string, TaskFile>();
  next = 1;
  failCreate = false;
  delayCreateMs = 0;

  async findByLegacyId(id: string): Promise<TaskFile | undefined> {
    return [...this.tasks.values()].find(task => task.metadata?.pi_teams_legacy_id === id);
  }

  async create(input: any): Promise<TaskFile> {
    if (this.delayCreateMs) await new Promise(resolve => setTimeout(resolve, this.delayCreateMs));
    if (this.failCreate) {
      this.failCreate = false;
      throw new Error("simulated crash after inventory");
    }
    const id = `bd-${this.next++}`;
    const task: TaskFile = { id, subject: input.subject, description: input.description, status: "pending", blocks: [], blockedBy: [], owner: undefined, metadata: input.metadata, version: `v${this.next}` };
    this.tasks.set(id, task);
    return task;
  }

  async update(id: string, updates: Partial<TaskFile>): Promise<TaskFile> {
    const task = this.tasks.get(id)!;
    Object.assign(task, updates);
    if (updates.status === "deleted") task.status = "deleted";
    return task;
  }

  async addDependency(id: string, blockerId: string): Promise<TaskFile> {
    const task = this.tasks.get(id)!;
    const blocker = this.tasks.get(blockerId)!;
    if (!task.blockedBy.includes(blockerId)) task.blockedBy.push(blockerId);
    if (!blocker.blocks.includes(id)) blocker.blocks.push(id);
    return task;
  }

  async list(): Promise<TaskFile[]> { return [...this.tasks.values()].filter(task => task.status !== "deleted"); }
  async read(id: string): Promise<TaskFile> { return this.tasks.get(id)!; }
}

describe("task migration contract", () => {
  const team = "migration-unit";
  const workspace = path.join(os.tmpdir(), "migration-beads-workspace");

  beforeEach(() => {
    fs.rmSync(teamDir(team), { recursive: true, force: true });
    fs.rmSync(taskDir(team), { recursive: true, force: true });
    fs.mkdirSync(teamDir(team), { recursive: true });
    fs.mkdirSync(taskDir(team), { recursive: true });
    fs.writeFileSync(configPath(team), JSON.stringify({ name: team, members: [] }));
    fs.mkdirSync(workspace, { recursive: true });
  });

  function writeLegacy(): void {
    const blocker: TaskFile = { id: "1", subject: "Blocker", description: "first", status: "completed", blocks: ["2"], blockedBy: [], owner: "human", plan: "ship", planFeedback: "", metadata: { source: "legacy" } };
    const task: TaskFile = { id: "2", subject: "Task", description: "second", status: "in_progress", blocks: [], blockedBy: ["1"], owner: "worker", activeForm: "Doing", metadata: {} };
    fs.writeFileSync(path.join(taskDir(team), "1.json"), JSON.stringify(blocker, null, 2));
    fs.writeFileSync(path.join(taskDir(team), "2.json"), JSON.stringify(task, null, 2));
  }

  it("inventories, imports, reconciles, cuts over once, and retains source files", async () => {
    writeLegacy();
    const beads = new MigrationBeadsFixture();
    const first = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(first.cutover).toBe(true);
    expect(first.mismatches).toEqual([]);
    expect(Object.keys(first.mapping)).toEqual(["1", "2"]);
    expect(fs.existsSync(path.join(taskDir(team), "1.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath(team), "utf8")).taskBackend).toBe("beads");

    const second = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(second.alreadyCutOver).toBe(true);
    expect(second.cutover).toBe(true);
    expect(beads.tasks.size).toBe(2);

    const old = JSON.parse(fs.readFileSync(path.join(taskDir(team), "2.json"), "utf8"));
    old.description = "old client write after cutover";
    fs.writeFileSync(path.join(taskDir(team), "2.json"), JSON.stringify(old, null, 2));
    const orphan = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(orphan.orphanedLegacyWrites).toEqual([expect.objectContaining({ fileName: "2.json", kind: "changed" })]);
    expect(beads.tasks.get(first.mapping["2"])?.description).toBe("second");
  });

  it("survives a half migration by reusing the immutable inventory", async () => {
    writeLegacy();
    const beads = new MigrationBeadsFixture();
    beads.failCreate = true;
    const failed = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(failed.cutover).toBe(false);
    expect(failed.errors.join(" ")).toContain("simulated crash");
    expect(JSON.parse(fs.readFileSync(configPath(team), "utf8")).taskBackend).toBeUndefined();
    expect(fs.existsSync(failed.inventoryPath)).toBe(true);

    const recovered = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(recovered.cutover).toBe(true);
    expect(beads.tasks.size).toBe(2);
  });

  it("serializes concurrent migration attempts and preserves one legacy mapping", async () => {
    writeLegacy();
    const beads = new MigrationBeadsFixture();
    beads.delayCreateMs = 25;
    const [first, second] = await Promise.all([
      migrateTeamTasks({ teamName: team, workspace, beads: beads as any }),
      migrateTeamTasks({ teamName: team, workspace, beads: beads as any }),
    ]);
    expect(first.cutover || second.cutover).toBe(true);
    expect(beads.tasks.size).toBe(2);
    expect([...beads.tasks.values()].filter(task => task.metadata?.pi_teams_legacy_id === "1")).toHaveLength(1);
  });

  it("blocks pre-cutover legacy drift until a persisted operator override is reviewed", async () => {
    writeLegacy();
    const beads = new MigrationBeadsFixture();
    beads.failCreate = true;
    const failed = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    const taskPath = path.join(taskDir(team), "2.json");
    const changed = JSON.parse(fs.readFileSync(taskPath, "utf8"));
    changed.description = "drifted before cutover";
    fs.writeFileSync(taskPath, JSON.stringify(changed, null, 2));
    const blocked = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(blocked.cutover).toBe(false);
    expect(blocked.errors.join(" ")).toContain("source drift");

    const overridePath = path.join(taskDir(team), `.pi-teams-${team}-migration-override.json`);
    fs.writeFileSync(overridePath, JSON.stringify({
      schema: "pi-teams-task-migration/1/operator-override",
      teamName: team,
      inventorySha256: failed.inventorySha256,
      allowSourceDrift: true,
      operator: "test-operator",
      approvedAt: new Date().toISOString(),
    }));
    const overridden = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(overridden.cutover).toBe(true);
  });

  it("rejects an inventory whose raw bytes or parsed task payload was tampered with", async () => {
    writeLegacy();
    const beads = new MigrationBeadsFixture();
    beads.failCreate = true;
    const failed = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    const inventory = JSON.parse(fs.readFileSync(failed.inventoryPath, "utf8"));
    inventory.tasks[0].task.description = "tampered";
    fs.writeFileSync(failed.inventoryPath, JSON.stringify(inventory, null, 2));
    await expect(migrateTeamTasks({ teamName: team, workspace, beads: beads as any })).rejects.toThrow(/inventory (hash mismatch|task payload failed authentication)/);
  });

  it("refuses cutover when existing Beads mappings are duplicated", async () => {
    writeLegacy();
    const beads = new MigrationBeadsFixture();
    const duplicate: TaskFile = { id: "duplicate", subject: "duplicate", description: "", status: "pending", blocks: [], blockedBy: [], metadata: { pi_teams_legacy_id: "1" } };
    beads.tasks.set(duplicate.id, duplicate);
    beads.tasks.set("duplicate-2", { ...duplicate, id: "duplicate-2" });
    const report = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(report.cutover).toBe(false);
    expect(report.errors.join(" ")).toContain("Duplicate Beads legacy mappings");
  });
});
