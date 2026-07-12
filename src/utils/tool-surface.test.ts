import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import piTeams, { buildPiArgv } from "../../extensions/index";

const source = fs.readFileSync(path.join(process.cwd(), "extensions/index.ts"), "utf8");
const skill = fs.readFileSync(path.join(process.cwd(), "skills/teams.md"), "utf8");
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
});
