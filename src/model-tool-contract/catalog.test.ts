import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  CandidateEnsureWorkerParametersSchema,
  CandidateEnsureWorkerResultSchema,
  CandidateTaskCardSchema,
  CandidateTaskCreateParametersSchema,
  CandidateTaskCreateResultSchema,
  CandidateTaskReadParametersSchema,
  CandidateTaskReadResultSchema,
  CandidateTaskUpdateParametersSchema,
  CandidateTaskUpdateResultSchema,
  CandidateTeamCreateParametersSchema,
  CandidateTeamCreateResultSchema,
  CandidateTeamSyncParametersSchema,
  CandidateTeamSyncResultSchema,
  CandidateTeamSyncUnavailableResultSchema,
  CandidateWorkerStopParametersSchema,
  CandidateWorkerStopResultSchema,
  CandidateTeamShutdownParametersSchema,
  CandidateTeamShutdownResultSchema,
  CandidateTaskLinkParametersSchema,
  CandidateTaskLinkResultSchema,
  CandidateAlertSendParametersSchema,
  CandidateAlertSendResultSchema,
  candidateModelToolCatalog,
} from "./catalog";
import {
  parseCandidateToolResult,
  projectCandidateToolResult,
  serializeCandidateToolResult,
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

function schemasFor(tool: "team_create" | "team_sync" | "ensure_worker" | "task_create" | "task_read" | "task_update" | "worker_stop" | "team_shutdown" | "task_link" | "alert_send") {
  if (tool === "team_create") {
    return { parameters: CandidateTeamCreateParametersSchema, result: CandidateTeamCreateResultSchema };
  }
  if (tool === "team_sync") {
    return { parameters: CandidateTeamSyncParametersSchema, result: CandidateTeamSyncResultSchema };
  }
  if (tool === "ensure_worker") {
    return { parameters: CandidateEnsureWorkerParametersSchema, result: CandidateEnsureWorkerResultSchema };
  }
  if (tool === "task_create") {
    return { parameters: CandidateTaskCreateParametersSchema, result: CandidateTaskCreateResultSchema };
  }
  if (tool === "task_read") return { parameters: CandidateTaskReadParametersSchema, result: CandidateTaskReadResultSchema };
  if (tool === "task_update") return { parameters: CandidateTaskUpdateParametersSchema, result: CandidateTaskUpdateResultSchema };
  if (tool === "worker_stop") return { parameters: CandidateWorkerStopParametersSchema, result: CandidateWorkerStopResultSchema };
  if (tool === "team_shutdown") return { parameters: CandidateTeamShutdownParametersSchema, result: CandidateTeamShutdownResultSchema };
  if (tool === "task_link") return { parameters: CandidateTaskLinkParametersSchema, result: CandidateTaskLinkResultSchema };
  return { parameters: CandidateAlertSendParametersSchema, result: CandidateAlertSendResultSchema };
}

describe("candidate model-tool catalog", () => {
  it("creates a Team from only its stable identity and purpose", () => {
    const valid = { name: "release-team", purpose: "Prepare and verify the public release." };
    expect(Check(CandidateTeamCreateParametersSchema, valid)).toBe(true);

    for (const invalid of [
      {},
      { name: "release-team" },
      { purpose: "Prepare and verify the public release." },
      { ...valid, separate_windows: true },
      { ...valid, task_backend: "beads" },
    ]) {
      expect(Check(CandidateTeamCreateParametersSchema, invalid), JSON.stringify(invalid)).toBe(false);
    }
  });

  it("uses the shared standard TypeBox 2,000-string-unit limit", () => {
    const base = {
      task_id: "task-1",
      operation_id: "context-boundary",
      expected_version: "v_0123456789abcdef",
    };
    expect(Check(CandidateTaskUpdateParametersSchema, {
      updates: [{ ...base, current_context: "a".repeat(2_000) }],
    })).toBe(true);
    expect(Check(CandidateTaskUpdateParametersSchema, {
      updates: [{ ...base, current_context: "a".repeat(2_001) }],
    })).toBe(false);
    const multiCodeUnit = "👩🏽‍🚀".repeat(1_001);
    expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(multiCodeUnit)]).toHaveLength(1_001);
    expect(Check(CandidateTaskUpdateParametersSchema, {
      updates: [{ ...base, current_context: multiCodeUnit }],
    })).toBe(false);
  });

  it("accepts Task goals through 1,000 string units across calls and Task cards", () => {
    const createItem = { operation_id: "goal-boundary", title: "Goal boundary" };
    for (const length of [160, 161, 1_000]) {
      const goal = "g".repeat(length);
      expect(Check(CandidateTaskCreateParametersSchema, { tasks: [{ ...createItem, goal }] }), String(length)).toBe(true);
      expect(Check(CandidateTaskCardSchema, {
        id: "task-1",
        title: createItem.title,
        goal,
        status: "open",
        current_context: "Not started.",
        version: "raw-version",
      }), String(length)).toBe(true);
    }

    const goal = "g".repeat(1_001);
    expect(Check(CandidateTaskCreateParametersSchema, { tasks: [{ ...createItem, goal }] })).toBe(false);
    expect(Check(CandidateTaskCardSchema, {
      id: "task-1",
      title: createItem.title,
      goal,
      status: "open",
      current_context: "Not started.",
      version: "raw-version",
    })).toBe(false);
  });

  it("keeps observation outcomes distinct from authority unavailability", () => {
    const common = {
      message: "No observation was committed.",
      state_changed: false,
      observation_advanced: false,
    } as const;
    expect(Check(CandidateTeamSyncResultSchema, { kind: "snapshot_required", ...common })).toBe(true);
    expect(Check(CandidateTeamSyncResultSchema, { kind: "cancelled", ...common })).toBe(true);
    expect(Check(CandidateTeamSyncUnavailableResultSchema, { kind: "unavailable", reason: "snapshot_required", ...common })).toBe(false);
    expect(Check(CandidateTeamSyncUnavailableResultSchema, { kind: "unavailable", reason: "cancelled", ...common })).toBe(false);
  });

  it("requires a caller-chosen create operation ID", () => {
    const task = { operation_id: "create-release", title: "Verify", goal: "Verify the release." };
    expect(Check(CandidateTaskCreateParametersSchema, { tasks: [task] })).toBe(true);
    expect(Check(CandidateTaskCreateParametersSchema, { tasks: [{ title: task.title, goal: task.goal }] })).toBe(false);
    expect(Check(CandidateTaskCreateParametersSchema, { tasks: [{ ...task, operation_id: "" }] })).toBe(false);
  });

  it("keeps Team identity implicit in both team_sync call forms", () => {
    expect(Check(CandidateTeamSyncParametersSchema, { view: "snapshot" })).toBe(true);
    expect(Check(CandidateTeamSyncParametersSchema, { view: "updates" })).toBe(true);

    for (const invalid of [
      {},
      { view: "events" },
      { team_name: "release-team", view: "snapshot" },
      { view: "updates", cursor: "7" },
      { view: "updates", wait_ms: 300_000 },
      { view: "snapshot", continuation: "opaque" },
      { view: "updates", task_ids: ["task-1"] },
    ]) {
      expect(Check(CandidateTeamSyncParametersSchema, invalid), JSON.stringify(invalid)).toBe(false);
    }

    expect(CandidateTeamSyncParametersSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["view"],
    });
    expect(Object.keys(CandidateTeamSyncParametersSchema.properties)).toEqual(["view"]);
    expect(CandidateTeamSyncParametersSchema.properties.view).toMatchObject({ enum: ["snapshot", "updates"] });
  });

  it("accepts only a Worker name and deep semantic scope", () => {
    const valid = { name: "release-verifier", scope: "Own independent release verification." };
    expect(Check(CandidateEnsureWorkerParametersSchema, valid)).toBe(true);

    for (const invalid of [
      {},
      { name: "release-verifier" },
      { scope: "Own independent release verification." },
      { ...valid, team_name: "release-team" },
      { ...valid, task_id: "task-1" },
    ]) {
      expect(Check(CandidateEnsureWorkerParametersSchema, invalid), JSON.stringify(invalid)).toBe(false);
    }

    expect(CandidateEnsureWorkerParametersSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["name", "scope"],
    });
    expect(Object.keys(CandidateEnsureWorkerParametersSchema.properties)).toEqual(["name", "scope"]);
  });

  it("keeps all calls and raw results executable against the matching schema", () => {
    expect(candidateModelToolCatalog.status).toBe("candidate");
    expect(candidateModelToolCatalog.modelResultProjection).toMatchObject({
      status: "accepted",
      version: "2",
    });
    expect(candidateModelToolCatalog.tools.map((tool) => tool.name)).toEqual(["team_create", "task_create", "task_read", "task_update", "team_sync", "ensure_worker", "worker_stop", "team_shutdown", "task_link", "alert_send"]);

    for (const tool of candidateModelToolCatalog.tools) {
      const schemas = schemasFor(tool.name);
      for (const example of tool.examples) {
        expect(Check(schemas.parameters, example.call), `${example.id} call`).toBe(true);
        expect(Check(schemas.result, example.result), `${example.id} result`).toBe(true);
      }
    }

    for (const scenario of candidateModelToolCatalog.scenarios) {
      const schemas = schemasFor(scenario.tool);
      expect(Check(schemas.parameters, scenario.call), `${scenario.id} call`).toBe(true);
      expect(Check(schemas.result, scenario.result), `${scenario.id} result`).toBe(true);
    }
  });

  it("projects raw semantic results into validated named model JSON", () => {
    const cases = [
      ...candidateModelToolCatalog.tools.flatMap((tool) =>
        tool.examples.map((example) => ({ tool: tool.name, id: example.id, result: example.result })),
      ),
      ...candidateModelToolCatalog.scenarios.map((scenario) => ({
        tool: scenario.tool,
        id: scenario.id,
        result: scenario.result,
      })),
    ];

    for (const candidate of cases) {
      const projection = projectCandidateToolResult(candidate.tool, candidate.result);
      const content = serializeCandidateToolResult(candidate.tool, candidate.result);
      expect(projection, `${candidate.id} model projection`).toBeDefined();
      expect(content, `${candidate.id} named JSON`).toBe(JSON.stringify(projection));
      expect(parseCandidateToolResult(candidate.tool, content), candidate.id).toEqual(projection);
    }
  });

  it("renders a scenario-first review artifact for both calls", () => {
    const html = renderModelToolContractReview(candidateModelToolCatalog, governance, provenance);
    expect(html).toContain("Candidate · not registered with Pi");
    expect(html).toContain('meta name="scope"');
    expect(html).toContain(governance.scope);
    expect(html).toContain("start-team");
    expect(html).toContain("deep-worker-scope");
    expect(html).toContain("post-compaction-warm-up");
    expect(html).toContain("routine-supervision-update");
    expect(html).toContain("catalog-sha");
    expect(html).toContain("design-sha");
    expect(html.indexOf("Leader scenarios first")).toBeLessThan(html.indexOf("Candidate function 1 of 10"));
    expect(html).toContain("team_create({ name, purpose })");
    expect(html).toContain("team_sync({ view })");
    expect(html).toContain("ensure_worker({ name, scope })");
    expect(html).toContain("task_create({ tasks: [{ operation_id, … }] })");
    expect(html).toContain("task_read({ task_ids })");
    expect(html).toContain("task_update({ updates })");
    expect(html).toContain("worker_stop({ worker })");
    expect(html).toContain("team_shutdown({ })");
    expect(html).toContain("task_link({ task_id, relation, target_id, action, expected_version })");
    expect(html).toContain("alert_send({ target, kind, text, task_id, task_version })");
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
