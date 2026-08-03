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
const skill = read("skills/pi-team-bright/SKILL.md");
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
  "ensure_worker",
  "task_create",
  "task_link",
  "task_read",
  "task_update",
  "team_create",
  "team_shutdown",
  "team_sync",
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
      "src/model-tool-contract/result-projection.ts",
      "src/model-tool-contract/tui-projection.ts",
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
    expect(current).toMatch(/Lifecycle stage: \*\*sharing\*\*/);
    expect(current).toMatch(/Sources of truth/);
  });

  it("uses team_sync as the single projection and event-wait surface", () => {
    const sync = tool("team_sync");
    expect(sync.parameters.properties).toEqual(expect.objectContaining({ view: expect.anything() }));
    expect(sync.parameters.properties).not.toHaveProperty("team_name");
    expect(sync.parameters.properties).not.toHaveProperty("cursor");
    expect(sync.description).toMatch(/current|incremental|supervision/i);
    expect(skill).toMatch(/snapshot|updates/);
    expect(skill).toMatch(/For a new Team, call `team_create` before the first `team_sync`/);
  });

  it("makes Worker claim and timeout recovery rules explicit", () => {
    const previousAgentName = process.env.PI_AGENT_NAME;
    process.env.PI_AGENT_NAME = "worker-surface-test";
    const workerTools: RegisteredTool[] = [];
    try {
      piTeams({
        registerTool(candidate: RegisteredTool) { workerTools.push(candidate); },
        on() {},
        sendUserMessage() {},
      } as never);
    } finally {
      if (previousAgentName === undefined) delete process.env.PI_AGENT_NAME;
      else process.env.PI_AGENT_NAME = previousAgentName;
    }
    const workerUpdate = workerTools.find(candidate => candidate.name === "task_update");
    expect(workerUpdate?.description).toMatch(/claim=true.+atomic claim.+no status/is);
    expect(JSON.stringify(workerUpdate?.parameters.properties?.claim)).toMatch(/do not include.+status/i);
    expect(skill).toMatch(/claim=true.+alone/is);
    expect(skill).toMatch(/Beads timeout.+unknown authority outcome/is);
    expect(skill).toMatch(/same operation ID and identical/i);
  });

  it("keeps terminal window placement as Team policy", () => {
    expect(tool("team_create").parameters.properties).toEqual(expect.objectContaining({ name: expect.anything(), purpose: expect.anything() }));
    expect(tool("team_create").parameters.properties).not.toHaveProperty("separate_windows");
    expect(tool("ensure_worker").parameters.properties).not.toHaveProperty("separate_window");
  });

  it("binds goal-driven Tasks to Workers", () => {
    const create = tool("task_create");
    const update = tool("task_update");
    expect(create.parameters.properties).toHaveProperty("tasks");
    expect(update.parameters.properties).toHaveProperty("updates");
    expect(JSON.stringify(update.parameters.properties?.updates)).toContain("expected_version");
    expect(JSON.stringify(update.parameters.properties?.updates)).toContain("journal_entries");
    expect(skill).toMatch(/success signals|acceptance criteria/);
    expect(skill).toMatch(/closes with evidence|blocks with blocker evidence/);
  });

  it("separates stable Worker identity from assigned work", () => {
    const ensure = tool("ensure_worker");
    expect(ensure.parameters.properties).toHaveProperty("scope");
    expect(ensure.parameters.properties).not.toHaveProperty("prompt");
    expect(ensure.description).toMatch(/reuse|idempotent/i);

    const stop = tool("worker_stop");
    expect(stop.parameters.properties).toHaveProperty("worker");
    expect(stop.parameters.properties).not.toHaveProperty("agent_name");
    expect(stop.description).toMatch(/nonterminal|assigned/i);
  });

  it("keeps exceptional communication to one typed Alert tool", () => {
    const alert = tool("alert_send");
    expect(alert.parameters).toMatchObject({ anyOf: expect.any(Array) });
    const alertSchema = JSON.stringify(alert.parameters);
    for (const kind of ["clarification", "attention", "announcement"]) {
      expect(alertSchema).toContain(kind);
    }
    expect(skill).toMatch(/clarification, attention, or announcements/);
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
