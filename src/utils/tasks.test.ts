// Project: pi-teams
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addTaskDependency,
  createTask,
  evaluatePlan,
  listTasks,
  readTask,
  submitPlan,
  updateTask,
} from "./tasks";
import * as paths from "./paths";

const testDir = path.join(os.tmpdir(), `pi-teams-task-authority-${process.pid}`);

describe("Task authority boundary", () => {
  beforeEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(testDir, { recursive: true });
    vi.spyOn(paths, "configPath").mockReturnValue(path.join(testDir, "config.json"));
    fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify({ name: "test-team" }));
    delete process.env.PI_TEAMS_BEADS_WORKSPACE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
    delete process.env.PI_TEAMS_BEADS_WORKSPACE;
  });

  it("fails every runtime Task operation closed for an unmigrated Team", async () => {
    const expected = /npm run migrate:tasks -- test-team <absolute-beads-workspace>/;
    await expect(createTask("test-team", "subject", "description")).rejects.toThrow(expected);
    await expect(updateTask("test-team", "1", { status: "in_progress" })).rejects.toThrow(expected);
    await expect(readTask("test-team", "1")).rejects.toThrow(expected);
    await expect(listTasks("test-team")).rejects.toThrow(expected);
    await expect(submitPlan("test-team", "1", "plan")).rejects.toThrow(expected);
    await expect(evaluatePlan("test-team", "1", "approve")).rejects.toThrow(expected);
    await expect(addTaskDependency("test-team", "1", "2")).rejects.toThrow(expected);
  });

  it("includes the configured migration target in the remediation command", async () => {
    process.env.PI_TEAMS_BEADS_WORKSPACE = "/tmp/operator-beads";
    await expect(readTask("test-team", "1")).rejects.toThrow(
      "npm run migrate:tasks -- test-team /tmp/operator-beads",
    );
  });
});
