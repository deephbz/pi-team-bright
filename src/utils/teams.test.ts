import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addMember, configureBeadsTaskBackend, createTeam, deactivateMembership } from "./teams";
import * as paths from "./paths";

const testDir = path.join(os.tmpdir(), `pi-teams-authority-${process.pid}`);
const configFile = path.join(testDir, "config.json");
const tasksDir = path.join(testDir, "tasks");
const teamName = "authority-unit";
const inventorySha256 = "a".repeat(64);

function marker(state: "prepared" | "active") {
  return {
    state,
    teamName,
    inventoryPath: path.join(tasksDir, "inventory.json"),
    inventorySha256,
    workspace: path.join(testDir, "beads-workspace"),
    markerPath: path.join(tasksDir, `.pi-teams-${teamName}-cutover.jsonl`),
    cutoverAt: new Date(0).toISOString(),
  };
}

describe("TeamConfig authority recovery", () => {
  beforeEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(testDir, { recursive: true });
    vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
    vi.spyOn(paths, "configPath").mockReturnValue(configFile);
    vi.spyOn(paths, "taskDir").mockReturnValue(tasksDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it.each(["{\"name\":\"authority-unit\"", "not-json"])("fails closed on a crash-truncated or malformed config (%s)", async (raw: string) => {
    fs.writeFileSync(configFile, raw, { mode: 0o640 });

    await expect(createTeam(teamName, "new-session", "lead")).rejects.toThrow(/malformed.*refusing to overwrite/i);
    expect(fs.readFileSync(configFile, "utf8")).toBe(raw);
    expect(fs.statSync(configFile).mode & 0o7777).toBe(0o640);
  });

  it.each(["active", "prepared"] as const)("does not initialize legacy authority when config is missing and marker is %s", async state => {
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, `.pi-teams-${teamName}-cutover.jsonl`), `${JSON.stringify(marker(state))}\n`);

    await expect(createTeam(teamName, "new-session", "lead")).rejects.toThrow(/config is missing.*refusing to initialize a new Task authority/i);
    expect(fs.existsSync(configFile)).toBe(false);
  });

  it("persists the resolved pane policy in TeamConfig", async () => {
    const policy = { leader_share: 0.7, worker_tiling: "linear" as const };
    const created = await createTeam(
      teamName, "session", "lead", "", undefined, undefined, undefined, undefined,
      undefined, undefined, { backend: "tmux", leadTarget: { backend: "tmux", kind: "pane", targetId: "%leader" } },
      "model-tools", policy,
    );

    expect(created.paneLayout).toEqual(policy);
    expect(JSON.parse(fs.readFileSync(configFile, "utf8")).paneLayout).toEqual(policy);
  });

  it("refuses an invalid pane policy before writing TeamConfig", async () => {
    await expect(createTeam(
      teamName, "session", "lead", "", undefined, undefined, undefined, undefined,
      undefined, undefined, { backend: "tmux" }, "model-tools",
      { leader_share: 0.7, worker_tiling: "grid" as const },
    )).rejects.toThrow(/unsupported.*tmux/i);
    expect(fs.existsSync(configFile)).toBe(false);
  });

  it("preserves the old config when an atomic TeamConfig rename fails", async () => {
    const initial = await createTeam(teamName, "session", "lead");
    const before = fs.readFileSync(configFile, "utf8");
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated atomic rename failure");
    });

    await expect(addMember(teamName, {
      agentId: "worker-id",
      pendingLaunchId: "launch-worker-id",
      name: "worker",
      agentType: "teammate",
      joinedAt: 1,
      tmuxPaneId: "",
      cwd: "/tmp",
      subscriptions: [],
    })).rejects.toThrow("simulated atomic rename failure");

    expect(rename).toHaveBeenCalled();
    expect(fs.readFileSync(configFile, "utf8")).toBe(before);
    expect(initial.members).toHaveLength(1);
    expect(fs.readdirSync(testDir).some(name => name.endsWith(".tmp"))).toBe(false);
  });

  it("preserves Beads authority, workspace, cutover evidence, and permissions across recreation", async () => {
    await createTeam(teamName, "session", "lead");
    fs.chmodSync(configFile, 0o640);
    const cutover = {
      inventoryPath: path.join(tasksDir, "inventory.json"),
      inventorySha256,
      markerPath: path.join(tasksDir, `.pi-teams-${teamName}-cutover.jsonl`),
      cutoverAt: new Date(0).toISOString(),
    };
    await configureBeadsTaskBackend(teamName, path.join(testDir, "beads-workspace"), {
      schema: "pi-teams-beads-authority/1",
      backend: "dolt",
      database: "dolt",
      doltDatabase: "teams_test",
      projectId: "teams-test-project",
    }, cutover);
    const current = JSON.parse(fs.readFileSync(configFile, "utf8"));
    await deactivateMembership(teamName, current.members[0].membershipId, "team_shutdown");

    const recreated = await createTeam(teamName, "recreated-session", "new-lead");

    expect(recreated.taskBackend).toBe("beads");
    expect(recreated.taskWorkspace).toBe(path.join(testDir, "beads-workspace"));
    expect(recreated.taskCutover).toEqual(cutover);
    expect(recreated.leadSessionId).toBe("recreated-session");
    expect(fs.statSync(configFile).mode & 0o7777).toBe(0o640);
  });

  it("never reconnects a reused team name to legacy after a Beads cutover marker", async () => {
    const legacy = await createTeam(teamName, "session", "lead");
    await deactivateMembership(teamName, legacy.members[0].membershipId!, "team_shutdown");
    const closed = JSON.parse(fs.readFileSync(configFile, "utf8"));
    fs.writeFileSync(configFile, JSON.stringify({ ...closed, taskBackend: undefined, taskWorkspace: undefined, taskCutover: undefined }, null, 2));
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, `.pi-teams-${teamName}-cutover.jsonl`), `${JSON.stringify(marker("active"))}\n`);
    const before = fs.readFileSync(configFile, "utf8");

    await expect(createTeam(teamName, "recreated-session", "new-lead")).rejects.toThrow(/refusing to reconnect.*legacy tasks/i);
    expect(fs.readFileSync(configFile, "utf8")).toBe(before);
  });
});
