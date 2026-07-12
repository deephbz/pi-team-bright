import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "extensions/index.ts"), "utf8");
const skill = fs.readFileSync(path.join(process.cwd(), "skills/teams.md"), "utf8");
const shippedTools = [...source.matchAll(/name: "([a-z_]+)"/g)].map(match => match[1]).filter(name => !["team-lead"].includes(name));

describe("registered PiTeams tool surface", () => {
  it("documents exactly the 21 registered tools", () => {
    expect(shippedTools).toHaveLength(21);
    expect(new Set(shippedTools).size).toBe(21);
    for (const tool of shippedTools) expect(skill).toContain(`\`${tool}\``);
  });

  it("does not teach removed tool names", () => {
    for (const removed of ["team_delete", "read_config", "force_kill_teammate", "task_get"]) {
      expect(skill).not.toMatch(new RegExp("^### `" + removed + "`$", "m"));
    }
  });
});
