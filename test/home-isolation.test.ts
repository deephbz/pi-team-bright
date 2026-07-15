import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PI_DIR, TASKS_DIR, TEAMS_DIR, ensureDirs } from "../src/utils/paths";
import { saveTeamTemplate } from "../src/utils/predefined-teams";

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

describe("Vitest HOME isolation", () => {
  it("resolves every user-scoped Pi path inside the worker HOME, never the operator HOME", () => {
    const testRoot = process.env.PI_TEAMS_VITEST_ROOT;
    const testHome = process.env.PI_TEAMS_VITEST_HOME;
    const operatorHome = process.env.PI_TEAMS_VITEST_OPERATOR_HOME;

    expect(testRoot).toBeTruthy();
    expect(testHome).toBeTruthy();
    expect(operatorHome).toBeTruthy();
    expect(testHome).not.toBe(operatorHome);
    expect(os.homedir()).toBe(testHome);
    expect(isWithin(testHome!, testRoot!)).toBe(true);
    expect(process.env.BD_DISABLE_EVENT_FLUSH).toBe("1");
    expect(process.env.BD_DISABLE_METRICS).toBe("1");

    const userScopedPaths = [
      PI_DIR,
      TEAMS_DIR,
      TASKS_DIR,
      path.join(testHome!, ".pi", "agent", "sessions"),
      path.join(testHome!, ".pi", "agent", "agents"),
      path.join(testHome!, ".pi", "agent", "teams"),
      path.join(testHome!, ".pi", "teams.yaml"),
    ];
    for (const candidate of userScopedPaths) {
      expect(isWithin(candidate, testHome!)).toBe(true);
      expect(isWithin(candidate, operatorHome!)).toBe(false);
    }

    ensureDirs();
    const template = saveTeamTemplate(
      {
        name: "home-isolation-sentinel",
        members: [{
          name: "sentinel-worker",
          agentType: "teammate",
          prompt: "test-only prompt",
        }],
      },
      { templateName: "home-isolation-sentinel", scope: "user" },
    );

    expect(isWithin(template.teamsYamlPath, testHome!)).toBe(true);
    expect(isWithin(template.agentsDir, testHome!)).toBe(true);
    expect(fs.existsSync(path.join(testHome!, ".pi", "teams.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(testHome!, ".pi", "agent", "agents", "sentinel-worker.md"))).toBe(true);
  });
});
