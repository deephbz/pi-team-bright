import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PI_DIR, TASKS_DIR, TEAMS_DIR, ensureDirs } from "../src/utils/paths";
import { saveTeamTemplate } from "../src/utils/predefined-teams";
import { proveIsolatedHome } from "./home-guard";

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

describe("HOME isolation proof", () => {
  it("refuses a HOME that os.homedir() does not follow", () => {
    const other = fs.mkdtempSync(path.join(process.env.PI_TEAMS_VITEST_ROOT!, "unfollowed-"));
    expect(() => proveIsolatedHome(other)).toThrow(/HOME isolation failed.*No test code ran\./);
    expect(() => proveIsolatedHome(process.env.PI_TEAMS_VITEST_HOME!)).not.toThrow();
  });

  it("runs in every Vitest config through the shared setup file", () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const configs = ["vitest.config.ts", "vitest.full.config.ts", "vitest.exhaustive.config.ts", "sim/attribution.config.ts", "sim/v31-campaign.config.ts", "sim/mutants/gate.config.ts"];
    const found = [...fs.readdirSync(packageRoot), ...fs.readdirSync(path.join(packageRoot, "sim")).map(name => `sim/${name}`), ...fs.readdirSync(path.join(packageRoot, "sim", "mutants")).map(name => `sim/mutants/${name}`)]
      .filter(name => /\.config\.[cm]?[jt]s$/.test(name) && fs.readFileSync(path.join(packageRoot, name), "utf8").includes("defineConfig"));
    expect(found.sort()).toEqual([...configs].sort());
    for (const config of configs) {
      expect(fs.readFileSync(path.join(packageRoot, config), "utf8"), config).toContain('setupFiles: ["./test/setup.ts"]');
    }
    expect(fs.readFileSync(path.join(packageRoot, "test", "setup.ts"), "utf8")).toMatch(/process\.env\.HOME = home;[\s\S]*proveIsolatedHome\(home\);[\s\S]*mkdirSync\(agentDir/);
  });
});
