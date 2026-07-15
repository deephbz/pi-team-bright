import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TaskFile } from "./models";
import { configPath, taskDir, teamDir } from "./paths";
import { LegacyTaskFile, migrateTeamTasks } from "./task-migration";

class MigrationBeadsFixture {
  tasks = new Map<string, any>();
  next = 1;
  failCreate = false;
  failList = false;
  listCalls = 0;
  delayCreateMs = 0;

  async findByLegacyId(id: string): Promise<any | undefined> {
    const matches = [...this.tasks.values()].filter(task => task.internalMetadata?.pi_teams_legacy_id === id);
    if (matches.length > 1) throw new Error(`Duplicate Beads tasks map to legacy Task ${id}`);
    return matches[0];
  }

  async create(input: any): Promise<any> {
    if (this.delayCreateMs) await new Promise(resolve => setTimeout(resolve, this.delayCreateMs));
    if (this.failCreate) {
      this.failCreate = false;
      throw new Error("simulated crash after inventory");
    }
    const id = `bd-${this.next++}`;
    const task = { id, title: input.title, description: input.description, design: input.design, status: "open", relations: [], assignee: input.assignee, internalMetadata: input.internalMetadata, version: `v${this.next}` };
    this.tasks.set(id, task);
    return task;
  }

  async update(id: string, updates: Partial<TaskFile>): Promise<any> {
    if (updates.status === "closed" && Object.keys(updates).some(key => key !== "status")) {
      throw new Error(`terminal ${updates.status} must be a separate mutation`);
    }
    const task = this.tasks.get(id)!;
    Object.assign(task, updates);
    return task;
  }

  async mutateLink(id: string, link: { relation: string; targetId: string; action: string }): Promise<any> {
    const task = this.tasks.get(id)!;
    if (link.action === "add" && !task.relations.some((relation: any) => relation.relation === link.relation && relation.targetId === link.targetId)) {
      task.relations.push({ relation: link.relation, targetId: link.targetId });
    }
    return task;
  }

  async list(): Promise<any[]> {
    this.listCalls += 1;
    if (this.failList) throw new Error("configured Beads authority is unavailable");
    return [...this.tasks.values()];
  }
  async read(id: string): Promise<any> { return this.tasks.get(id)!; }
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
    fs.mkdirSync(path.join(workspace, ".beads"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".beads", "metadata.json"), JSON.stringify({
      database: "dolt",
      backend: "dolt",
      dolt_database: "migration_test",
      project_id: "migration-test-project",
    }));
  });

  function writeLegacy(): void {
    const blocker: LegacyTaskFile = { id: "1", subject: "Blocker", description: "first", status: "completed", blocks: ["2"], blockedBy: [], owner: "human", plan: "ship", planFeedback: "", metadata: { source: "legacy" } };
    const task: LegacyTaskFile = { id: "2", subject: "Task", description: "second", status: "in_progress", blocks: [], blockedBy: ["1"], owner: "worker", activeForm: "Doing", metadata: {} };
    fs.writeFileSync(path.join(taskDir(team), "1.json"), JSON.stringify(blocker, null, 2));
    fs.writeFileSync(path.join(taskDir(team), "2.json"), JSON.stringify(task, null, 2));
  }

  function initializeFakeBeadsRoot(root: string, suffix: string): void {
    fs.mkdirSync(path.join(root, ".beads"), { recursive: true });
    fs.writeFileSync(path.join(root, ".beads", "metadata.json"), JSON.stringify({
      database: "dolt",
      backend: "dolt",
      dolt_database: `migration_${suffix}`,
      project_id: `migration-${suffix}`,
    }));
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
    expect(second.mapping).toEqual(first.mapping);
    expect(second.after).toEqual(first.after);
    expect(second.errors).toEqual([]);
    expect(beads.tasks.size).toBe(2);

    const old = JSON.parse(fs.readFileSync(path.join(taskDir(team), "2.json"), "utf8"));
    old.description = "old client write after cutover";
    fs.writeFileSync(path.join(taskDir(team), "2.json"), JSON.stringify(old, null, 2));
    const orphan = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(orphan.orphanedLegacyWrites).toEqual([expect.objectContaining({ fileName: "2.json", kind: "changed" })]);
    expect(beads.tasks.get(first.mapping["2"])?.description).toBe("second");
  });

  it("fails closed when a cutover rerun supplies a different workspace", async () => {
    writeLegacy();
    const beads = new MigrationBeadsFixture();
    const first = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(first.cutover).toBe(true);

    const wrongWorkspace = path.join(os.tmpdir(), `missing-pi-teams-workspace-${process.pid}`);
    fs.rmSync(wrongWorkspace, { recursive: true, force: true });
    const rerun = await migrateTeamTasks({ teamName: team, workspace: wrongWorkspace, beads: beads as any });

    expect(rerun).toMatchObject({ alreadyCutOver: true, cutover: true, authority: "beads" });
    expect(rerun.errors.join(" ")).toContain("refusing migration rerun");
    expect(rerun.errors.join(" ")).toContain(path.resolve(workspace));
    expect(rerun.mapping).toEqual({});
  });

  it("refuses initial cutover when only an ancestor is an initialized Beads root", async () => {
    writeLegacy();
    const childWorkspace = path.join(workspace, "uninitialized-child");
    fs.mkdirSync(childWorkspace, { recursive: true });
    const beads = new MigrationBeadsFixture();

    const report = await migrateTeamTasks({ teamName: team, workspace: childWorkspace, beads: beads as any });

    expect(report.cutover).toBe(false);
    expect(report.errors.join(" ")).toContain("not an initialized authority root");
    expect(beads.tasks.size).toBe(0);
    expect(JSON.parse(fs.readFileSync(configPath(team), "utf8")).taskBackend).toBeUndefined();
  });

  it("fails closed when the configured cutover workspace no longer exists", async () => {
    writeLegacy();
    const beads = new MigrationBeadsFixture();
    const first = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(first.cutover).toBe(true);
    fs.rmSync(workspace, { recursive: true, force: true });

    const rerun = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });

    expect(rerun).toMatchObject({ alreadyCutOver: true, cutover: true, authority: "beads" });
    expect(rerun.errors.join(" ")).toContain("not an initialized authority root");
    expect(rerun.mapping).toEqual({});
  });

  it("probes the configured Beads authority even when the migration inventory is empty", async () => {
    const beads = new MigrationBeadsFixture();
    const first = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(first).toMatchObject({ cutover: true, before: { count: 0 }, after: { count: 0 } });
    const callsAfterCutover = beads.listCalls;
    beads.failList = true;

    const rerun = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });

    expect(beads.listCalls).toBeGreaterThan(callsAfterCutover);
    expect(rerun).toMatchObject({ alreadyCutOver: true, cutover: true, authority: "beads" });
    expect(rerun.errors.join(" ")).toContain("configured Beads authority is unavailable");
    expect(rerun.after).toEqual({ count: 0, beadsIds: [] });
  });

  it("fails closed when an already-cut-over config has no stable taskAuthorityId", async () => {
    const beads = new MigrationBeadsFixture();
    const first = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(first.cutover).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath(team), "utf8"));
    delete config.taskAuthorityId;
    fs.writeFileSync(configPath(team), JSON.stringify(config, null, 2));
    const callsBeforeRerun = beads.listCalls;

    const rerun = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });

    expect(rerun).toMatchObject({ alreadyCutOver: true, cutover: true, authority: "beads" });
    expect(rerun.errors.join(" ")).toContain("no taskAuthorityId");
    expect(beads.listCalls).toBe(callsBeforeRerun);
  });

  it("fails closed when an already-cut-over config has no external authority fingerprint", async () => {
    const beads = new MigrationBeadsFixture();
    const first = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(first.cutover).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath(team), "utf8"));
    delete config.taskAuthorityFingerprint;
    fs.writeFileSync(configPath(team), JSON.stringify(config, null, 2));

    const rerun = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });

    expect(rerun.errors.join(" ")).toContain("no taskAuthorityFingerprint");
  });

  it("rejects same-path replacement with a different valid Beads fingerprint", async () => {
    const beads = new MigrationBeadsFixture();
    const first = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(first.cutover).toBe(true);
    const metadataPath = path.join(workspace, ".beads", "metadata.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    metadata.project_id = "replacement-project";
    metadata.dolt_database = "replacement_database";
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));

    const rerun = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });

    expect(rerun.errors.join(" ")).toContain("fingerprint mismatch");
    expect(rerun.mapping).toEqual({});
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
    expect([...beads.tasks.values()].filter(task => task.internalMetadata?.pi_teams_legacy_id === "1")).toHaveLength(1);
  });

  it("serializes two requested workspaces behind one Team migration lease", async () => {
    writeLegacy();
    const otherWorkspace = path.join(os.tmpdir(), `migration-other-workspace-${process.pid}`);
    fs.rmSync(otherWorkspace, { recursive: true, force: true });
    initializeFakeBeadsRoot(otherWorkspace, "other");
    const firstBeads = new MigrationBeadsFixture();
    firstBeads.delayCreateMs = 50;
    const secondBeads = new MigrationBeadsFixture();
    const firstPromise = migrateTeamTasks({ teamName: team, workspace, beads: firstBeads as any });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondPromise = migrateTeamTasks({ teamName: team, workspace: otherWorkspace, beads: secondBeads as any });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.cutover).toBe(true);
    expect(first.errors).toEqual([]);
    expect(second.errors.join(" ")).toContain("refusing migration rerun");
    expect(secondBeads.tasks.size).toBe(0);
    expect(JSON.parse(fs.readFileSync(configPath(team), "utf8")).taskWorkspace).toBe(path.resolve(workspace));
    fs.rmSync(otherWorkspace, { recursive: true, force: true });
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
    const duplicate = { id: "duplicate", title: "duplicate", description: "", status: "open", relations: [], internalMetadata: { pi_teams_legacy_id: "1" } };
    beads.tasks.set(duplicate.id, duplicate);
    beads.tasks.set("duplicate-2", { ...duplicate, id: "duplicate-2" });
    const report = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });
    expect(report.cutover).toBe(false);
    expect(report.errors.join(" ")).toMatch(/Duplicate Beads (legacy mappings|tasks map to legacy Task)/);
  });

  it("fails closed before writes when legacy IDs are duplicated", async () => {
    writeLegacy();
    const duplicate = JSON.parse(fs.readFileSync(path.join(taskDir(team), "1.json"), "utf8"));
    fs.writeFileSync(path.join(taskDir(team), "3.json"), JSON.stringify({ ...duplicate, subject: "duplicate identity" }));
    const beads = new MigrationBeadsFixture();

    await expect(migrateTeamTasks({ teamName: team, workspace, beads: beads as any }))
      .rejects.toThrow(/Duplicate legacy Task IDs/);
    expect(beads.tasks.size).toBe(0);
  });

  it("fails closed before writes when a legacy dependency target is missing", async () => {
    writeLegacy();
    const taskPath = path.join(taskDir(team), "2.json");
    const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
    task.blockedBy.push("404");
    fs.writeFileSync(taskPath, JSON.stringify(task));
    const beads = new MigrationBeadsFixture();

    await expect(migrateTeamTasks({ teamName: team, workspace, beads: beads as any }))
      .rejects.toThrow(/dependencies reference missing targets.*2->404/);
    expect(beads.tasks.size).toBe(0);
  });

  it("reconciles legacy metadata before authority cutover", async () => {
    writeLegacy();
    const beads = new MigrationBeadsFixture();
    const report = await migrateTeamTasks({ teamName: team, workspace, beads: beads as any });

    expect(report.cutover).toBe(true);
    expect(beads.tasks.get(report.mapping["1"])?.internalMetadata).toMatchObject({
      source: "legacy",
      pi_teams_legacy_id: "1",
      pi_teams_migration_schema: "pi-teams-task-migration/1",
    });
  });
});
