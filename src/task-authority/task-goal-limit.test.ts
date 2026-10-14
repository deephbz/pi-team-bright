import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Check } from "typebox/value";
import { loadTaskGoalMaxLength, parseTaskGoalMaxLength } from "./task-goal-limit";
import { validatePtbSettingsNamespace } from "../utils/model-role-settings";

const dirs: string[] = [];
function settings(value?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-goal-limit-"));
  dirs.push(dir);
  if (value !== undefined) fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(value));
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Task goal settings", () => {
  it.each([0, -1, 1.5, "2000", null, true, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("refuses invalid limit %s", value => {
    expect(() => parseTaskGoalMaxLength(value)).toThrow("positive safe integer");
  });

  it("refuses invalid files and shapes instead of silently using defaults", () => {
    for (const value of [{ pi_team_bright: { task: null } }, { pi_team_bright: { task: { goal_max_length: null } } }]) {
      expect(() => loadTaskGoalMaxLength(settings(value))).toThrow();
    }
    const dir = settings();
    fs.writeFileSync(path.join(dir, "settings.json"), "{");
    expect(() => loadTaskGoalMaxLength(dir)).toThrow("Cannot load pi_team_bright.task.goal_max_length");
  });

  it("validates editor saves and diagnoses unsupported project overrides", () => {
    const options = { source: "global" as const, file: "settings.json" };
    expect(validatePtbSettingsNamespace({ task: { goal_max_length: 2400 } }, options)).toEqual([]);
    expect(validatePtbSettingsNamespace({ task: { goal_max_length: 0 } }, options)[0].message).toContain("positive safe integer");
    expect(validatePtbSettingsNamespace({ task: { goal_max_length: 2400 } }, { ...options, source: "project" })[0].message).toContain("global-only");
  });

  it.each([undefined, { pi_team_bright: { task: { goal_max_length: 2400 } } }, { pi_team_bright: { task: { goal_max_length: 800 } } }])(
    "keeps graph input, returned cards, and runtime validation on one resolved boundary", async config => {
      vi.stubEnv("PI_CODING_AGENT_DIR", settings(config));
      vi.resetModules();
      const { TaskGraphApplyParametersSchema, GraphTaskCardSchema } = await import("./graph-control-schemas.js");
      const { TaskCardCompleteSchema, isTaskCardGoal } = await import("./task-domain.js");
      const limit = config?.pi_team_bright.task.goal_max_length ?? 1600;
      const card = {
        id: "task", title: "Task", assignee: "builder", needs: [], status: "ready", state: { kind: "ready" },
        current_context: "Not started.", version: "v_1234567890abcdef", attempts_started: 0,
      };
      for (const length of [limit, limit + 1]) {
        const goal = "g".repeat(length);
        const accepted = length === limit;
        expect(Check(TaskGraphApplyParametersSchema, { operation_id: "apply", tasks: [{ key: "task", title: "Task", goal, assignee: "builder" }] })).toBe(accepted);
        expect(Check(GraphTaskCardSchema, { ...card, goal })).toBe(accepted);
        expect(Check(TaskCardCompleteSchema, { id: "task", title: "Task", goal, status: "open", current_context: "Not started.", version: card.version })).toBe(accepted);
        expect(isTaskCardGoal(goal)).toBe(accepted);
      }
      // Editing the file cannot change runtime validation without changing the advertised schema.
      fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), JSON.stringify({ pi_team_bright: { task: { goal_max_length: 1 } } }));
      expect(isTaskCardGoal("g".repeat(limit))).toBe(true);
    },
  );
});
