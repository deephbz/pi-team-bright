import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  EnsureWorkerParametersSchema,
  EnsureWorkerResultSchema,
  TaskCreateParametersSchema,
  TaskCreateResultSchema,
  TaskReadParametersSchema,
  TaskReadResultSchema,
  TaskUpdateParametersSchema,
  TaskUpdateResultSchema,
  TeamCreateParametersSchema,
  TeamCreateResultSchema,
  TeamSyncParametersSchema,
  TeamSyncResultSchema,
  TeamSyncUnavailableResultSchema,
  WorkerStopParametersSchema,
  WorkerStopResultSchema,
  TeamShutdownParametersSchema,
  TeamShutdownResultSchema,
  AlertSendParametersSchema,
  AlertSendResultSchema,
  modelToolCatalog,
} from "./catalog";
import { TaskCardSchema } from "./task-domain";
import { taskVersionRef } from "./task-version-ref";
import {
  ModelResultSchemas,
  parseToolResult,
  projectToolResult,
  serializeToolResult,
} from "./result-projection";
import { renderModelToolContractReview, type ContractReviewGovernance } from "./render-review-html";

const governance: ContractReviewGovernance = {
  document_id: "pi-team-bright-model-invoked-tool-contract",
  document_kind: "evergreen-shaping-contract",
  lifecycle_stage: "shaping",
  scope: "Model-facing Pi Team Bright coordination tools.",
  responsibility: "Own candidate call and result shapes.",
  authority: "Shaping intent only.",
  excludes: "Backend selection.",
  maintenance: "Replace superseded shaping content.",
};

const provenance = {
  baseRevision: "abc123",
  catalogSha256: "catalog-sha",
  designSha256: "design-sha",
};

function schemasFor(tool: "team_create" | "team_sync" | "ensure_worker" | "task_create" | "task_read" | "task_update" | "worker_stop" | "team_shutdown" | "alert_send") {
  if (tool === "team_create") {
    return { parameters: TeamCreateParametersSchema, result: TeamCreateResultSchema };
  }
  if (tool === "team_sync") {
    return { parameters: TeamSyncParametersSchema, result: TeamSyncResultSchema };
  }
  if (tool === "ensure_worker") {
    return { parameters: EnsureWorkerParametersSchema, result: EnsureWorkerResultSchema };
  }
  if (tool === "task_create") {
    return { parameters: TaskCreateParametersSchema, result: TaskCreateResultSchema };
  }
  if (tool === "task_read") return { parameters: TaskReadParametersSchema, result: TaskReadResultSchema };
  if (tool === "task_update") return { parameters: TaskUpdateParametersSchema, result: TaskUpdateResultSchema };
  if (tool === "worker_stop") return { parameters: WorkerStopParametersSchema, result: WorkerStopResultSchema };
  if (tool === "team_shutdown") return { parameters: TeamShutdownParametersSchema, result: TeamShutdownResultSchema };
  return { parameters: AlertSendParametersSchema, result: AlertSendResultSchema };
}

describe("candidate model-tool catalog", () => {
  it("creates a Team from its stable identity, purpose, and optional pane policy", () => {
    const valid = { name: "release-team", purpose: "Prepare and verify the public release." };
    expect(Check(TeamCreateParametersSchema, valid)).toBe(true);
    expect(Check(TeamCreateParametersSchema, {
      ...valid,
      pane_layout: { leader_share: 0.1001, worker_tiling: "grid" },
    })).toBe(true);

    for (const invalid of [
      {},
      { name: "release-team" },
      { purpose: "Prepare and verify the public release." },
      { ...valid, separate_windows: true },
      { ...valid, task_backend: "beads" },
      { ...valid, pane_layout: { leader_share: 0.1, worker_tiling: "linear" } },
      { ...valid, pane_layout: { leader_share: 1, worker_tiling: "linear" } },
      { ...valid, pane_layout: { leader_share: 0.7, worker_tiling: "diagonal" } },
    ]) {
      expect(Check(TeamCreateParametersSchema, invalid), JSON.stringify(invalid)).toBe(false);
    }
  });

  it("uses the shared standard TypeBox 2,000-string-unit limit", () => {
    const base = {
      task_id: "task-1",
      operation_id: "context-boundary",
      expected_version: "v_0123456789abcdef",
    };
    expect(Check(TaskUpdateParametersSchema, {
      updates: [{ ...base, current_context: "a".repeat(2_000) }],
    })).toBe(true);
    expect(Check(TaskUpdateParametersSchema, {
      updates: [{ ...base, current_context: "a".repeat(2_001) }],
    })).toBe(false);
    const multiCodeUnit = "👩🏽‍🚀".repeat(1_001);
    expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(multiCodeUnit)]).toHaveLength(1_001);
    expect(Check(TaskUpdateParametersSchema, {
      updates: [{ ...base, current_context: multiCodeUnit }],
    })).toBe(false);
  });

  it("accepts Task goals through 1,000 string units across calls and Task cards", () => {
    const createItem = { key: "goal", title: "Goal boundary", assignee: "verifier" };
    for (const length of [160, 161, 1_000]) {
      const goal = "g".repeat(length);
      expect(Check(TaskCreateParametersSchema, { operation_id: "goal-boundary", tasks: [{ ...createItem, goal }] }), String(length)).toBe(true);
      expect(Check(TaskCardSchema, {
        id: "task-1",
        title: createItem.title,
        goal,
        status: "open",
        current_context: "Not started.",
        version: taskVersionRef("raw-version"),
      }), String(length)).toBe(true);
    }

    const goal = "g".repeat(1_001);
    expect(Check(TaskCreateParametersSchema, { operation_id: "goal-boundary", tasks: [{ ...createItem, goal }] })).toBe(false);
    expect(Check(TaskCardSchema, {
      id: "task-1",
      title: createItem.title,
      goal,
      status: "open",
      current_context: "Not started.",
      version: taskVersionRef("raw-version"),
    })).toBe(false);
  });

  it("encodes complete and incomplete Task cards as exclusive variants", () => {
    const base = {
      id: "task-1",
      title: "Verify",
      status: "open" as const,
      current_context: "Not started.",
      version: taskVersionRef("raw-version"),
    };
    const warning = {
      task_id: "task-1",
      truncated_fields: [],
      incomplete_fields: ["goal"],
      message: "The goal is incomplete.",
    };
    expect(Check(TaskCardSchema, { ...base, goal: "Verify the release." })).toBe(true);
    expect(Check(TaskCardSchema, { ...base, goal_state: "incomplete", projection_warnings: [warning] })).toBe(true);
    expect(Check(TaskCardSchema, { ...base })).toBe(false);
    expect(Check(TaskCardSchema, { ...base, goal: "Verify the release.", goal_state: "incomplete", projection_warnings: [warning] })).toBe(false);

    const modelIncomplete = {
      kind: "found",
      task: { ...base, version: "v_0123456789abcdef", goal_state: "incomplete", projection_warnings: [warning] },
    };
    expect(Check(ModelResultSchemas.task_read, modelIncomplete)).toBe(true);
    expect(Check(ModelResultSchemas.task_read, { kind: "found", task: { ...modelIncomplete.task } })).toBe(true);
    expect(Check(ModelResultSchemas.task_read, { kind: "found", task: { ...modelIncomplete.task, goal: "not allowed" } })).toBe(false);
  });

  it("keeps observation outcomes distinct from authority unavailability", () => {
    const common = {
      message: "No observation was committed.",
      state_changed: false,
      observation_advanced: false,
    } as const;
    expect(Check(TeamSyncResultSchema, { kind: "snapshot_required", ...common })).toBe(true);
    expect(Check(TeamSyncResultSchema, { kind: "cancelled", ...common })).toBe(true);
    expect(Check(TeamSyncUnavailableResultSchema, { kind: "unavailable", reason: "snapshot_required", ...common })).toBe(false);
    expect(Check(TeamSyncUnavailableResultSchema, { kind: "unavailable", reason: "cancelled", ...common })).toBe(false);
  });

  it("requires one caller-chosen graph operation ID and local Task keys", () => {
    const task = { key: "verify", title: "Verify", goal: "Verify the release.", assignee: "verifier" };
    expect(Check(TaskCreateParametersSchema, { operation_id: "create-release", tasks: [task] })).toBe(true);
    expect(Check(TaskCreateParametersSchema, { tasks: [task] })).toBe(false);
    expect(Check(TaskCreateParametersSchema, { operation_id: "", tasks: [task] })).toBe(false);
    expect(Check(TaskCreateParametersSchema, { operation_id: "create-release", tasks: [{ title: task.title, goal: task.goal }] })).toBe(false);
    expect(Check(TaskCreateParametersSchema, { operation_id: "create-release", tasks: [{ ...task, needs: ["plan"] }] })).toBe(true);
    expect(Check(TaskCreateParametersSchema, { operation_id: "create-release", tasks: [{ ...task, needs: ["bad key"] }] })).toBe(false);
    expect(Check(TaskCreateParametersSchema, { operation_id: "create-release", tasks: [task], dependencies: [] })).toBe(false);
  });

  it("keeps Team identity implicit in both team_sync call forms", () => {
    expect(Check(TeamSyncParametersSchema, { view: "snapshot" })).toBe(true);
    expect(Check(TeamSyncParametersSchema, { view: "updates" })).toBe(true);

    for (const invalid of [
      {},
      { view: "events" },
      { team_name: "release-team", view: "snapshot" },
      { view: "updates", cursor: "7" },
      { view: "updates", wait_ms: 300_000 },
      { view: "snapshot", continuation: "opaque" },
      { view: "updates", task_ids: ["task-1"] },
    ]) {
      expect(Check(TeamSyncParametersSchema, invalid), JSON.stringify(invalid)).toBe(false);
    }

    expect(TeamSyncParametersSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["view"],
    });
    expect(Object.keys(TeamSyncParametersSchema.properties)).toEqual(["view"]);
    expect(TeamSyncParametersSchema.properties.view).toMatchObject({ enum: ["snapshot", "updates"] });
  });

  it("accepts only a Worker name and deep semantic scope", () => {
    const valid = { name: "release-verifier", scope: "Own independent release verification." };
    expect(Check(EnsureWorkerParametersSchema, valid)).toBe(true);

    for (const invalid of [
      {},
      { name: "release-verifier" },
      { scope: "Own independent release verification." },
      { ...valid, team_name: "release-team" },
      { ...valid, task_id: "task-1" },
    ]) {
      expect(Check(EnsureWorkerParametersSchema, invalid), JSON.stringify(invalid)).toBe(false);
    }

    expect(EnsureWorkerParametersSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["name", "scope"],
    });
    expect(Object.keys(EnsureWorkerParametersSchema.properties)).toEqual(["name", "scope"]);
  });

  it("keeps all calls and raw results executable against the matching schema", () => {
    expect(modelToolCatalog.status).toBe("candidate");
    expect(modelToolCatalog.modelResultProjection).toMatchObject({
      status: "accepted",
      version: "2",
    });
    expect(modelToolCatalog.tools.map((tool) => tool.name)).toEqual(["team_create", "task_create", "task_read", "task_update", "team_sync", "ensure_worker", "worker_stop", "team_shutdown", "alert_send"]);

    for (const tool of modelToolCatalog.tools) {
      const schemas = schemasFor(tool.name);
      for (const example of tool.examples) {
        expect(Check(schemas.parameters, example.call), `${example.id} call`).toBe(true);
        expect(Check(schemas.result, example.result), `${example.id} result`).toBe(true);
      }
    }

    for (const scenario of modelToolCatalog.scenarios) {
      const schemas = schemasFor(scenario.tool);
      expect(Check(schemas.parameters, scenario.call), `${scenario.id} call`).toBe(true);
      expect(Check(schemas.result, scenario.result), `${scenario.id} result`).toBe(true);
    }
  });

  it("projects raw semantic results into validated named model JSON", () => {
    const cases = [
      ...modelToolCatalog.tools.flatMap((tool) =>
        tool.examples.map((example) => ({ tool: tool.name, id: example.id, result: example.result })),
      ),
      ...modelToolCatalog.scenarios.map((scenario) => ({
        tool: scenario.tool,
        id: scenario.id,
        result: scenario.result,
      })),
    ];

    for (const candidate of cases) {
      const projection = projectToolResult(candidate.tool, candidate.result);
      const content = serializeToolResult(candidate.tool, candidate.result);
      expect(projection, `${candidate.id} model projection`).toBeDefined();
      expect(content, `${candidate.id} named JSON`).toBe(JSON.stringify(projection));
      expect(parseToolResult(candidate.tool, content), candidate.id).toEqual(projection);
    }
  });

  it("renders a scenario-first review artifact for both calls", () => {
    const html = renderModelToolContractReview(modelToolCatalog, governance, provenance);
    expect(html).toContain("Not registered with Pi");
    expect(html).toContain('meta name="scope"');
    expect(html).toContain(governance.scope);
    expect(html).toContain("start-team");
    expect(html).toContain("deep-worker-scope");
    expect(html).toContain("post-compaction-warm-up");
    expect(html).toContain("routine-supervision-update");
    expect(html).toContain("catalog-sha");
    expect(html).toContain("design-sha");
    expect(html.indexOf("Leader scenarios first")).toBeLessThan(html.indexOf("Function 1 of 9"));
    expect(html).toContain("team_create({ name, purpose })");
    expect(html).toContain("team_sync({ view })");
    expect(html).toContain("ensure_worker({ name, scope })");
    expect(html).toContain("task_create({ operation_id, tasks: [{ key, title, goal, assignee, needs? }] })");
    expect(html).toContain("task_read({ task_ids })");
    expect(html).toContain("task_update({ updates })");
    expect(html).toContain("worker_stop({ worker })");
    expect(html).toContain("team_shutdown({ })");
    expect(html).not.toContain("task_link({");
    expect(html).toContain("alert_send({ to, kind, text, task_id, task_version })");
    expect(html).toContain("Raw semantic JSON");
    expect(html).toContain("Validated model projection");
    expect(html).toContain("accepted");
    expect(html).not.toContain("positional JSON tuple");
    expect(html).not.toContain("<code>S</code> snapshot");
    expect(html).toContain("No candidate limit is placed on Team Workers, nonterminal Tasks, or journal entries.");
    expect(html).toContain("Paging is not part of this contract.");
    expect(html).toContain("<strong>80</strong>");
    expect(html).toContain("<strong>1000</strong>");
    expect(html).toContain("<strong>2000</strong>");
    expect(html).not.toContain("team_sync({ team_name, view })");
    expect(html).toContain("Parameter JSON Schema");
  });
});
