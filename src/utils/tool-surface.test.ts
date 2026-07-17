import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import piTeams from "../../extensions/index";

type RegisteredTool = {
  name: string;
  description: string;
  parameters: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const skill = read("skills/pi-teams/SKILL.md");
const reference = read("docs/reference.md");
const current = read("docs/current/README.md");
const registeredTools: RegisteredTool[] = [];

piTeams({
  registerTool(tool: RegisteredTool) {
    registeredTools.push(tool);
  },
  on() {},
  sendUserMessage() {},
} as never);

const expectedTools = [
  "alert_send",
  "task_create",
  "task_link",
  "task_read",
  "task_update",
  "team_create",
  "team_shutdown",
  "team_sync",
  "worker_ensure",
  "worker_stop",
];

function tool(name: string): RegisteredTool {
  const found = registeredTools.find(candidate => candidate.name === name);
  expect(found, `missing registered tool ${name}`).toBeDefined();
  return found!;
}

describe("minimal PiTeams agent-facing surface", () => {
  it("registers exactly ten composable tools", () => {
    const names = registeredTools.map(candidate => candidate.name);
    expect(names).toHaveLength(10);
    expect(new Set(names).size).toBe(10);
    expect([...names].sort()).toEqual(expectedTools);
  });

  it("keeps executable schemas authoritative and docs as one-hop pointers", () => {
    expect(reference).toMatch(/exact contract truth.+executable/is);
    for (const source of [
      "extensions/index.ts",
      "src/utils/tool-result-renderer.ts",
      "src/utils/tool-results.ts",
      "src/utils/models.ts",
      "src/utils/tasks.ts",
      "src/utils/team-events.ts",
      "src/utils/tool-surface.test.ts",
    ]) {
      expect(reference).toContain(source);
    }
    expect(reference).not.toMatch(/^### `[^`]+`$/m);
    expect(reference).not.toMatch(/Required:|Optional:/);
    expect(skill).toMatch(/executable schema.+source of truth/is);
    expect(skill).not.toMatch(/^### `[^`]+`$/m);
    expect(current).toMatch(/Lifecycle stage: \*\*hardening\*\*/);
    expect(current).toMatch(/Sources of truth/);
  });

  it("uses team_sync as the single projection and event-wait surface", () => {
    const sync = tool("team_sync");
    expect(sync.parameters.properties).toEqual(expect.objectContaining({
      team_name: expect.anything(),
      cursor: expect.anything(),
      wait_ms: expect.anything(),
      task_ids: expect.anything(),
      event_types: expect.anything(),
      limit: expect.anything(),
      continuation: expect.anything(),
    }));
    expect(JSON.stringify(sync.parameters.properties?.event_types)).toMatch(/task/);
    expect(JSON.stringify(sync.parameters.properties?.event_types)).toMatch(/worker/);
    expect(JSON.stringify(sync.parameters.properties?.event_types)).toMatch(/alert/);
    expect(sync.description).toMatch(/event|wait|block/i);
    expect(skill).toMatch(/returned sync cursor.+positive wait/is);
  });

  it("binds goal-driven Tasks to Workers", () => {
    const create = tool("task_create");
    const update = tool("task_update");
    expect(create.parameters.properties).toHaveProperty("acceptance_criteria");
    expect(update.parameters.properties).toHaveProperty("acceptance_criteria");
    expect(JSON.stringify(update.parameters.properties?.status)).toContain('"blocked"');
    expect(JSON.stringify(update.parameters.properties?.status)).toContain('"closed"');
    expect(update.parameters.properties).toHaveProperty("append_note");
    expect(skill).toMatch(/acceptance criteria/);
    expect(skill).toMatch(/closes with evidence|blocks with blocker evidence/);
  });

  it("separates stable Worker identity from assigned work", () => {
    const ensure = tool("worker_ensure");
    expect(ensure.parameters.properties).toHaveProperty("profile");
    expect(ensure.parameters.properties).not.toHaveProperty("prompt");
    expect(ensure.description).toMatch(/reuse|idempotent/i);

    const stop = tool("worker_stop");
    expect(stop.parameters.properties).toHaveProperty("worker");
    expect(stop.parameters.properties).not.toHaveProperty("agent_name");
    expect(stop.description).toMatch(/nonterminal|assigned/i);
  });

  it("keeps exceptional communication to one typed Alert tool", () => {
    const alert = tool("alert_send");
    expect(alert.parameters.properties).toEqual(expect.objectContaining({
      team_name: expect.anything(),
      to: expect.anything(),
      kind: expect.anything(),
      text: expect.anything(),
      task_id: expect.anything(),
      task_version: expect.anything(),
    }));
    const alertSchema = JSON.stringify(alert.parameters.properties);
    for (const kind of ["clarification", "attention", "announcement"]) {
      expect(alertSchema).toContain(kind);
    }
    expect(skill).toMatch(/Alerts only for clarification, attention, or announcements/);
  });

  it("does not re-expose alternate work, polling, catalog, or template tools", () => {
    const names = registeredTools.map(candidate => candidate.name);
    for (const removed of [
      "send_message",
      "broadcast_message",
      "read_inbox",
      "task_list",
      "check_teammate",
      "report_stale_agent_sessions",
      "list_predefined_teams",
      "list_predefined_agents",
      "create_predefined_team",
      "save_team_as_template",
    ]) {
      expect(names).not.toContain(removed);
      expect(skill).not.toMatch(new RegExp("^### `" + removed + "`$", "m"));
    }
  });
});
