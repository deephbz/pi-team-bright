import { describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import piTeams, { buildPiArgv } from "../../extensions/index";
import { BeadsTaskStore } from "./beads";
import * as paths from "./paths";
import { configureBeadsTaskBackend, createTeam } from "./teams";

const source = fs.readFileSync(path.join(process.cwd(), "extensions/index.ts"), "utf8");
const skill = fs.readFileSync(path.join(process.cwd(), "skills/teams.md"), "utf8");
const reference = fs.readFileSync(path.join(process.cwd(), "docs/reference.md"), "utf8");
const publicDocs = [
  fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8"),
  fs.readFileSync(path.join(process.cwd(), "docs/guide.md"), "utf8"),
  reference,
];
const registeredTools: Array<{ name: string; parameters: { properties?: Record<string, unknown> } }> = [];
piTeams({
  registerTool(tool: { name: string; parameters: { properties?: Record<string, unknown> } }) {
    registeredTools.push(tool);
  },
  on() {},
  sendUserMessage() {},
} as never);
const shippedTools = registeredTools.map(tool => tool.name);

describe("registered PiTeams tool surface", () => {
  it("documents exactly the 21 registered tools", () => {
    expect(shippedTools).toHaveLength(21);
    expect(new Set(shippedTools).size).toBe(21);
    for (const tool of shippedTools) expect(skill).toContain(`\`${tool}\``);
  });

  it("documents every registered parameter in its corresponding skill section", () => {
    for (const tool of registeredTools) {
      const escaped = tool.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const section = skill.match(new RegExp("^### `" + escaped + "`([\\s\\S]*?)(?=^### |^## |(?![\\s\\S]))", "m"))?.[1];
      expect(section, `missing skill section for ${tool.name}`).toBeDefined();
      for (const parameter of Object.keys(tool.parameters.properties || {})) {
        expect(section, `${tool.name}.${parameter} is absent from the skill`).toContain(`\`${parameter}\``);
      }
    }
  });

  it("keeps the rebuilt reference surface and public call examples executable", () => {
    const referenceTools = [...reference.matchAll(/^### `([^`]+)`$/gm)].map(match => match[1]);
    expect(new Set(referenceTools)).toEqual(new Set(shippedTools));

    for (const tool of registeredTools) {
      const escaped = tool.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const section = reference.match(new RegExp("^### `" + escaped + "`([\\s\\S]*?)(?=^### |^## |(?![\\s\\S]))", "m"))?.[1];
      expect(section, `missing reference section for ${tool.name}`).toBeDefined();
      for (const parameter of Object.keys(tool.parameters.properties || {})) {
        expect(section, `${tool.name}.${parameter} is absent from the reference`).toContain(`\`${parameter}\``);
      }
    }

    for (const doc of publicDocs) {
      const callNames = [...doc.matchAll(/\b([a-z][a-z0-9_]+)\s*\(/g)].map(match => match[1]);
      for (const callName of callNames) {
        expect(shippedTools, `public docs teach unregistered call ${callName}()`).toContain(callName);
      }
      for (const removed of ["team_delete", "read_config", "force_kill_teammate", "task_get"]) {
        expect(doc, `public docs still teach removed tool ${removed}`).not.toContain(removed);
      }
    }
  });

  it("does not teach removed tool names", () => {
    for (const removed of ["team_delete", "read_config", "force_kill_teammate", "task_get"]) {
      expect(skill).not.toMatch(new RegExp("^### `" + removed + "`$", "m"));
    }
  });

  it("passes agent-definition tool allowlists through the argv-array launcher", () => {
    expect(buildPiArgv(["pi"], "provider/model", "high", ["read", "grep"])).toEqual([
      "pi", "--model", "provider/model:high", "--tools", "read,grep",
    ]);
    expect(source).toContain("params.thinking, agentDef?.tools");
    expect(source).toContain("agentDef.thinking, agentDef.tools");
  });

  it("teaches the model schema to preserve configured defaults when omitted", () => {
    expect(source.match(/Omit this parameter to use Pi's configured default model/g)).toHaveLength(2);
    expect(source).toContain("Omit this parameter to use the team or Pi default");
  });

  it.skipIf(spawnSync("bd", ["--version"], { stdio: "ignore" }).status !== 0)("retains Beads task authority for post-shutdown query and graph visualization", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-shutdown-"));
    const workspace = path.join(root, "workspace");
    const team = `shutdown-${process.pid}`;
    const teamRoot = path.join(root, "teams", team);
    const tasksRoot = path.join(root, "tasks", team);
    const originalCwd = process.cwd();
    vi.spyOn(paths, "teamDir").mockReturnValue(teamRoot);
    vi.spyOn(paths, "taskDir").mockReturnValue(tasksRoot);
    vi.spyOn(paths, "configPath").mockReturnValue(path.join(teamRoot, "config.json"));

    try {
      fs.mkdirSync(workspace, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: workspace });
      execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks"], { cwd: workspace, stdio: "ignore" });
      createTeam(team, "session", "lead");
      await configureBeadsTaskBackend(team, workspace, {
        inventoryPath: path.join(tasksRoot, "inventory.json"),
        inventorySha256: "a".repeat(64),
        cutoverAt: new Date(0).toISOString(),
      });
      const store = new BeadsTaskStore({ teamName: team, workspace, requireExpectedVersion: false });
      const task = await store.create({ subject: "Survives shutdown", description: "durable Beads task" });

      const shutdown = registeredTools.find(tool => tool.name === "team_shutdown") as unknown as { execute: Function };
      const result = await shutdown.execute("test", { team_name: team }, undefined, undefined, undefined);

      expect(result.details.taskAuthorityRetained).toBe(true);
      expect(fs.existsSync(teamRoot)).toBe(true);
      expect(fs.existsSync(tasksRoot)).toBe(true);
      expect((await new BeadsTaskStore({ teamName: team, workspace, requireExpectedVersion: false }).read(task.id)).subject).toBe("Survives shutdown");
      const graph = execFileSync("bd", ["graph", "--dot", task.id], { cwd: workspace, encoding: "utf8" });
      expect(graph).toContain(task.id);
    } finally {
      process.chdir(originalCwd);
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
